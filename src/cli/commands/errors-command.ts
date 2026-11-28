/**
 * `vessel errors [--json] [--limit N] [--id <error_id> | --run <run_id>]`
 * （0.14 DECISION-025 §1.5；q-error-e3 §3.9 下钻）。
 *
 * 最近错误摘要：默认只含 run/tool 级错误；`ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 时追加 process/shutdown/hook。
 * 本地读 trace；`--connect` 时调用 `events.list`。输出不含密钥 / stack。
 *
 * q-error-e3（§3.9）：
 * - `--id <error_id>`：单错误下钻——operation 链 + cause + at + details +
 *   注册表 hintKey 四段指引（发生了什么/为什么/怎么修/去哪看）；
 *   未注册码不编造指引（原始 message + error_id）。
 * - `--run <run_id>`：按 seq 升序列该 run 的错误事件。
 * - 摘要 additive `error_id`（下钻入口可发现）。
 *
 * @module vessel/errors-command
 */

import { loadConfig, type VesselConfig } from '../../../packages/config/src/index';
import {
  lookupErrorCode,
  readTraceEvents,
  type ReadTraceOptions,
  type TenantPaths,
} from '../../../packages/core/src/index';
import { formatConfigErrors } from '../../config/config-error-format';
import {
  resolveDataDir,
  resolveEffectiveTenantId,
  resolveSingleTenantPaths,
} from '../../data/data-paths';
import { t } from '../../i18n';
import { RpcClientError } from '../../rpc';
import { type ControlPlaneTargetOptions, resolveControlPlaneTarget } from '../control-plane-target';
import { ui } from '../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ErrorsCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  limit?: number;
  /** q-error-e3：按 envelope error_id 下钻（与 run 互斥） */
  id?: string;
  /** q-error-e3：按 run_id 列错误事件（seq 升序；与 id 互斥） */
  run?: string;
  now?: () => number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const READ_LIMIT = 500;

/** 用户可见错误（默认 errorLevel: user） */
const USER_ERROR_TYPES = ['run.failed', 'tool.call.failed'] as const;

/** 诊断级错误（errorLevel: all 或 showProcessErrors） */
const DIAGNOSTIC_ERROR_TYPES = ['process.error', 'shutdown.failed', 'hook.error'] as const;

interface ErrorSummary {
  type: string;
  ts: number;
  run_id: string;
  session_id?: string;
  tool_name?: string;
  error?: string;
  error_code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  http_status?: number;
  /** q-error-e3 additive：envelope error_id（下钻入口） */
  error_id?: string;
  /** q-error-e3 additive：事件 seq（--run 按 seq 排序） */
  seq?: number;
}

/** q-error-e3：--id 下钻视图（摘要 + envelope 关联字段；不含 stack 全文） */
interface ErrorDrilldown extends ErrorSummary {
  operation?: string;
  at?: number;
  cause?: Array<{ code?: string; message: string; operation?: string }>;
  details?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cap(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 事件 → 摘要（只保留可展示字段，不带 stack / prompt） */
export function summarizeErrorEvent(event: unknown): ErrorSummary | null {
  if (!isRecord(event)) return null;
  const type = pickString(event, 'type');
  const runId = pickString(event, 'run_id') ?? '-';
  const ts = pickNumber(event, 'ts');
  if (type === undefined || ts === undefined) return null;
  const data = isRecord(event.data) ? event.data : {};
  const error = pickString(data, 'error');
  const summary: ErrorSummary = {
    type,
    ts,
    run_id: runId,
    ...(pickString(data, 'session_id') !== undefined
      ? { session_id: pickString(data, 'session_id') }
      : {}),
    ...(pickString(data, 'tool_name') !== undefined
      ? { tool_name: pickString(data, 'tool_name') }
      : {}),
    ...(error !== undefined ? { error: cap(error) } : {}),
    ...(pickString(data, 'error_code') !== undefined
      ? { error_code: pickString(data, 'error_code') }
      : {}),
    ...(pickString(data, 'category') !== undefined
      ? { category: pickString(data, 'category') }
      : {}),
    ...(pickString(data, 'phase') !== undefined ? { phase: pickString(data, 'phase') } : {}),
    ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
    ...(pickNumber(data, 'http_status') !== undefined
      ? { http_status: pickNumber(data, 'http_status') }
      : {}),
    ...(pickString(data, 'error_id') !== undefined
      ? { error_id: pickString(data, 'error_id') }
      : {}),
    ...(pickNumber(event, 'seq') !== undefined ? { seq: pickNumber(event, 'seq') } : {}),
  };
  return summary;
}

/** q-error-e3：--id 下钻提取（cause 链只收 code/message/operation，不收 stack）。 */
function drilldownOf(event: unknown): ErrorDrilldown | null {
  const summary = summarizeErrorEvent(event);
  if (summary === null || !isRecord(event)) return null;
  const data = isRecord(event.data) ? event.data : {};
  const drilldown: ErrorDrilldown = { ...summary };
  const operation = pickString(data, 'operation');
  if (operation !== undefined) drilldown.operation = operation;
  const at = pickNumber(data, 'at');
  if (at !== undefined) drilldown.at = at;
  if (Array.isArray(data.cause)) {
    const cause: NonNullable<ErrorDrilldown['cause']> = [];
    for (const layer of data.cause) {
      if (!isRecord(layer)) continue;
      const message = pickString(layer, 'message');
      if (message === undefined) continue;
      cause.push({
        ...(pickString(layer, 'code') !== undefined ? { code: pickString(layer, 'code') } : {}),
        message: cap(message),
        ...(pickString(layer, 'operation') !== undefined
          ? { operation: pickString(layer, 'operation') }
          : {}),
      });
    }
    if (cause.length > 0) drilldown.cause = cause;
  }
  if (isRecord(data.details)) drilldown.details = data.details;
  return drilldown;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

function errorTypes(config: VesselConfig): string[] {
  const includeDiagnostics =
    config.ui?.errorLevel === 'all' || config.observability?.showProcessErrors === true;
  return [...USER_ERROR_TYPES, ...(includeDiagnostics ? DIAGNOSTIC_ERROR_TYPES : [])];
}

function eventArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result.events)) return result.events;
  return [];
}

function sortNewestFirst(events: ErrorSummary[]): ErrorSummary[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts;
    return a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0;
  });
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts) : date.toISOString();
}

/** q-error-e3：--run 按 seq 升序（缺 seq 回落 ts）。 */
function sortSeqAsc(events: ErrorSummary[]): ErrorSummary[] {
  return [...events].sort((a, b) => {
    const sa = a.seq ?? a.ts;
    const sb = b.seq ?? b.ts;
    return sa - sb;
  });
}

/**
 * q-error-e3（§3.9）：注册表 hintKey → 四段指引。
 * 未注册码（registry-miss / 未知）**不编造**——只提示原始信息口径。
 */
function hintLines(code: string | undefined): string[] {
  if (code === undefined) return [];
  const meta = lookupErrorCode(code);
  if (meta === undefined) return [`    ${ui.dim(t('errors.unknownCode'))}`];
  const key = meta.hintKey ?? `error.hint.${code}`;
  return [
    `    ${ui.brand(t('errors.hintWhat'))} ${t(`${key}.what`)}`,
    `    ${ui.brand(t('errors.hintWhy'))} ${t(`${key}.why`)}`,
    `    ${ui.brand(t('errors.hintFix'))} ${t(`${key}.fix`)}`,
    `    ${ui.brand(t('errors.hintVerify'))} ${t(`${key}.verify`)}`,
  ];
}

/** q-error-e3：--id 单错误下钻的人类输出（海洋绿既有样式）。 */
function renderDrilldown(drilldown: ErrorDrilldown): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${ui.dim(formatTimestamp(drilldown.ts))}  ${ui.brand(drilldown.type)}  run=${drilldown.run_id}` +
      `${drilldown.session_id !== undefined ? `  session=${drilldown.session_id}` : ''}` +
      `${drilldown.tool_name !== undefined ? `  tool=${drilldown.tool_name}` : ''}`,
  );
  if (drilldown.error !== undefined) lines.push(`    ${drilldown.error}`);
  const meta = [
    drilldown.error_id !== undefined ? `error_id=${drilldown.error_id}` : undefined,
    drilldown.error_code,
    drilldown.category,
    drilldown.phase,
    drilldown.retryable !== undefined ? `retryable=${drilldown.retryable}` : undefined,
    drilldown.http_status !== undefined ? `http=${drilldown.http_status}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  if (meta !== '') lines.push(`    ${ui.dim(meta)}`);
  if (drilldown.operation !== undefined) {
    lines.push(`    ${ui.brand(t('errors.operation'))} ${drilldown.operation}`);
  }
  if (drilldown.at !== undefined) {
    lines.push(`    ${ui.brand(t('errors.at'))} ${formatTimestamp(drilldown.at)}`);
  }
  if (drilldown.cause !== undefined) {
    lines.push(`    ${ui.brand(t('errors.cause'))}`);
    drilldown.cause.forEach((layer, index) => {
      lines.push(
        `      ${ui.dim(`[${index}]`)} ${layer.code !== undefined ? `${layer.code}: ` : ''}${layer.message}` +
          `${layer.operation !== undefined ? `  ${ui.dim(`(${layer.operation})`)}` : ''}`,
      );
    });
  }
  if (drilldown.details !== undefined) {
    lines.push(`    ${ui.brand(t('errors.details'))}`);
    for (const line of JSON.stringify(drilldown.details, null, 2).split('\n')) {
      lines.push(`      ${ui.dim(line)}`);
    }
  }
  lines.push(...hintLines(drilldown.error_code));
  return lines;
}

/** `vessel errors`：人类输出走海洋绿样式，`--json` 纯 JSON（无 ANSI）。 */
export async function errorsCommand(options: ErrorsCommandOptions = {}): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const json = options.json === true;
  const limit = resolveLimit(options.limit);

  // q-error-e3：--id 与 --run 互斥（下钻 vs 按 run 列表）。
  if (options.id !== undefined && options.run !== undefined) {
    return { exitCode: 1, stdout: '', stderr: t('errors.mutuallyExclusive') };
  }
  const drillId = options.id;
  const drillRun = options.run;

  let config: VesselConfig;
  let tenantId: string;
  let validationErrors: Array<{ path: string; message: string }> = [];
  let configPaths: { user: string; project: string } = { user: '', project: '' };

  if (options.config !== undefined) {
    config = options.config;
    tenantId = options.tenantId ?? 'default';
  } else {
    const loaded = await loadConfig({
      env,
      ...(options.tenantId != null ? { tenantId: options.tenantId } : {}),
    });
    config = loaded.config;
    tenantId = loaded.tenantId;
    validationErrors = loaded.validation.errors;
    configPaths = loaded.paths;
  }
  if (validationErrors.length > 0) {
    return {
      exitCode: 1,
      stdout: json
        ? JSON.stringify({
            errors: validationErrors.map(({ path, message }) => ({ path, message })),
          })
        : '',
      stderr: formatConfigErrors(validationErrors, { paths: configPaths }),
    };
  }
  const dataDir = options.dataDir ?? resolveDataDir(config, env);
  // 0.49 R1：单 id 以持久化 `<dataDir>/tenant.json` 为准。
  tenantId = resolveEffectiveTenantId(tenantId, dataDir);
  const types = errorTypes(config);

  const explicitConnect =
    (options.connectUrl !== null && options.connectUrl !== undefined) ||
    (env.VESSEL_CONNECT ?? '').trim() !== '';

  // q-error-e3：--id 按 error_id 过滤（id 已特异，不限 types）；--run 加 run_id。
  const filterParams: ReadTraceOptions =
    drillId !== undefined
      ? { error_id: drillId, limit: READ_LIMIT }
      : drillRun !== undefined
        ? { run_id: drillRun, types, limit: READ_LIMIT }
        : { types, limit: READ_LIMIT };

  let rawEvents: unknown[] = [];
  if (explicitConnect) {
    const resolved = await resolveControlPlaneTarget({
      ...options,
      config,
      dataDir,
      env,
      tenantId,
    });
    if (!resolved.ok) {
      return { exitCode: 1, stdout: '', stderr: resolved.error };
    }
    try {
      const result = await resolved.target.request('events.list', { ...filterParams });
      rawEvents = eventArray(result);
    } catch (error) {
      if (
        error instanceof RpcClientError &&
        (error.code === 'method_not_found' || error.code === 'not_supported')
      ) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'events.list is not available on this gateway.',
        };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await resolved.target.close().catch(() => undefined);
    }
  } else {
    // 0.49 T5（C6）：只读根布局；非根布局数据 fail-fast。
    let tenantPaths: TenantPaths;
    try {
      tenantPaths = resolveSingleTenantPaths(dataDir, tenantId);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    rawEvents = await readTraceEvents(tenantPaths.events_dir, filterParams);
  }

  // q-error-e3：--id 下钻分支（operation 链 + cause + at + details + 四段指引）。
  if (drillId !== undefined) {
    const drilldowns = rawEvents
      .map((event) => drilldownOf(event))
      .filter((event): event is ErrorDrilldown => event !== null);
    if (drilldowns.length === 0) {
      return {
        exitCode: 1,
        stdout: json ? JSON.stringify({ error_id: drillId, count: 0, events: [] }) : '',
        stderr: json ? '' : t('errors.idNotFound', { id: drillId }),
      };
    }
    const payload = {
      as_of: new Date(now()).toISOString(),
      error_id: drillId,
      count: drilldowns.length,
      events: drilldowns,
    };
    if (json) {
      return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
    }
    const lines: string[] = [ui.title(t('errors.drillTitle')), ui.rule(48)];
    for (const drilldown of drilldowns) {
      lines.push('', ...renderDrilldown(drilldown));
    }
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  }

  const summaries = rawEvents
    .map((event) => summarizeErrorEvent(event))
    .filter((event): event is ErrorSummary => event !== null);
  // q-error-e3：--run 按 seq 升序；缺省最新优先。
  const events = (drillRun !== undefined ? sortSeqAsc(summaries) : sortNewestFirst(summaries)).slice(
    0,
    limit,
  );

  const payload = {
    as_of: new Date(now()).toISOString(),
    error_level: config.ui?.errorLevel ?? 'user',
    ...(drillRun !== undefined ? { run_id: drillRun } : {}),
    count: events.length,
    events,
  };

  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(ui.title(drillRun !== undefined ? t('errors.runTitle') : t('errors.title')));
  lines.push(ui.rule(48));
  if (drillRun !== undefined) {
    lines.push(ui.kv('run', drillRun, 10));
  } else {
    lines.push(ui.kv(t('errors.level'), payload.error_level, 10));
  }
  if (events.length === 0) {
    lines.push('');
    lines.push(ui.info(drillRun !== undefined ? t('errors.runEmpty') : t('errors.empty')));
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  }
  lines.push('');
  lines.push(ui.section(t('errors.recent', { count: events.length })));
  for (const event of events) {
    const meta = [
      event.error_code,
      event.category,
      event.phase,
      event.retryable !== undefined ? `retryable=${event.retryable}` : undefined,
      event.http_status !== undefined ? `http=${event.http_status}` : undefined,
      event.error_id !== undefined ? `error_id=${event.error_id}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    lines.push(
      `  ${ui.dim(formatTimestamp(event.ts))}  ${ui.brand(event.type)}  run=${event.run_id}` +
        `${event.seq !== undefined ? `  seq=${event.seq}` : ''}` +
        `${event.session_id !== undefined ? `  session=${event.session_id}` : ''}` +
        `${event.tool_name !== undefined ? `  tool=${event.tool_name}` : ''}`,
    );
    if (event.error !== undefined) lines.push(`    ${event.error}`);
    if (meta !== '') lines.push(`    ${ui.dim(meta)}`);
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
