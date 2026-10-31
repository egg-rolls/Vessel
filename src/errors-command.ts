/**
 * `vessel errors [--json] [--limit N]`（0.14 DECISION-025 §1.5）。
 *
 * 最近错误摘要：默认只含 run/tool 级错误；`ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 时追加 process/shutdown/hook。
 * 本地读 trace；`--connect` 时调用 `events.list`。输出不含密钥 / stack。
 *
 * @module vessel/errors-command
 */

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import { readTraceEvents, resolveTenantPaths } from '../packages/core/src/index';
import { formatConfigErrors } from './config-error-format';
import { type ControlPlaneTargetOptions, resolveControlPlaneTarget } from './control-plane-target';
import { resolveDataDir } from './data-paths';
import { t } from './i18n';
import { RpcClientError } from './rpc';
import { ui } from './ui-style';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ErrorsCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  limit?: number;
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
  };
  return summary;
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

/** `vessel errors`：人类输出走暗金样式，`--json` 纯 JSON（无 ANSI）。 */
export async function errorsCommand(options: ErrorsCommandOptions = {}): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const json = options.json === true;
  const limit = resolveLimit(options.limit);

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
  const types = errorTypes(config);

  const explicitConnect =
    (options.connectUrl !== null && options.connectUrl !== undefined) ||
    (env.VESSEL_CONNECT ?? '').trim() !== '';

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
      const result = await resolved.target.request('events.list', {
        types,
        limit: READ_LIMIT,
        tenant_id: tenantId,
      });
      rawEvents = eventArray(result);
    } catch (error) {
      if (
        error instanceof RpcClientError &&
        (error.code === 'not_found' || error.code === 'not_supported')
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
    const traceDir = resolveTenantPaths(dataDir, tenantId).events_dir;
    rawEvents = await readTraceEvents(traceDir, { types, limit: READ_LIMIT });
  }

  const events = sortNewestFirst(
    rawEvents
      .map((event) => summarizeErrorEvent(event))
      .filter((event): event is ErrorSummary => event !== null),
  ).slice(0, limit);

  const payload = {
    as_of: new Date(now()).toISOString(),
    tenant_id: tenantId,
    error_level: config.ui?.errorLevel ?? 'user',
    count: events.length,
    events,
  };

  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(ui.title(t('errors.title')));
  lines.push(ui.rule(48));
  lines.push(ui.kv(t('errors.level'), payload.error_level, 10));
  if (events.length === 0) {
    lines.push('');
    lines.push(ui.info(t('errors.empty')));
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
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    lines.push(
      `  ${ui.dim(formatTimestamp(event.ts))}  ${ui.brand(event.type)}  run=${event.run_id}` +
        `${event.session_id !== undefined ? `  session=${event.session_id}` : ''}` +
        `${event.tool_name !== undefined ? `  tool=${event.tool_name}` : ''}`,
    );
    if (event.error !== undefined) lines.push(`    ${event.error}`);
    if (meta !== '') lines.push(`    ${ui.dim(meta)}`);
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
