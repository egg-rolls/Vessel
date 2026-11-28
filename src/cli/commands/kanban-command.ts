/**
 * `vessel kanban list|view` — 任务看板轻量读面（q-tooling）。
 *
 * kanban.list / kanban.view 的 CLI 包装：list 每卡一行摘要（progress 首句截断，
 * 支持 --column / --owner / --status 过滤），view 单卡全字段详情（含全量 progress）。
 * 数据源唯一 = gateway `kanban.*`（与 vessel 桥 / WebUI 同源）；本命令只读。
 *
 * 目标解析与 rpc list 同口径（resolveControlPlaneTarget）：缺省 attach 本地运行中
 * 的 gateway；`--node <id>` 经平台代理定向；`--connect <url>` 远端直连。
 * `--json` 输出原始 RPC 结果（纯数据、无 ANSI）；人类可读输出走 ui + i18n。
 *
 * @module vessel/commands/kanban-command
 */

import { t } from '../../i18n';
import { RpcClientError } from '../../rpc';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../control-plane-target';
import { ui } from '../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface KanbanListOptions extends ControlPlaneTargetOptions {
  column?: string;
  owner?: string;
  status?: string;
  json?: boolean;
}

export interface KanbanViewOptions extends ControlPlaneTargetOptions {
  json?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** 单元格长度上限：摘要保持一屏可读，完整内容走 view / --json。 */
const CELL_MAX = 60;

function cap(text: string, max = CELL_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorResult(error: unknown): CommandResult {
  // q-error-e1（D4）：板未配置 = 能力缺失 not_supported；缺卡/缺板文件 = 资源 not_found。
  if (error instanceof RpcClientError && error.code === 'not_supported') {
    return { exitCode: 1, stdout: '', stderr: t('kanban.unavailable') };
  }
  if (error instanceof RpcClientError && error.code === 'not_found') {
    // 缺卡（view id 不存在）与缺板文件都是 not_found：前者直报消息，后者给提示。
    if (error.message.includes('task not on board')) {
      return { exitCode: 1, stdout: '', stderr: `${error.code}: ${error.message}` };
    }
    return { exitCode: 1, stdout: '', stderr: t('kanban.unavailable') };
  }
  if (error instanceof RpcClientError && error.code === 'not_supported') {
    return { exitCode: 1, stdout: '', stderr: t('kanban.unavailable') };
  }
  return {
    exitCode: 1,
    stdout: '',
    stderr:
      error instanceof RpcClientError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
  };
}

async function callKanban(
  options: ControlPlaneTargetOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<
  { ok: true; target: ControlPlaneTarget; result: unknown } | { ok: false; error: CommandResult }
> {
  const resolved = await resolveControlPlaneTarget(options);
  if (!resolved.ok)
    return { ok: false, error: { exitCode: 1, stdout: '', stderr: resolved.error } };
  const target = resolved.target;
  try {
    const result = await target.request(method, params);
    return { ok: true, target, result };
  } catch (error) {
    return { ok: false, error: errorResult(error) };
  } finally {
    await target.close().catch(() => undefined);
  }
}

function targetLines(target: ControlPlaneTarget): string[] {
  const lines = [
    ui.title(t('kanban.title')),
    ui.rule(48),
    ui.kv(t('agents.source'), target.baseUrl, 10),
  ];
  if (target.instance !== undefined) lines.push(ui.kv(t('agents.instance'), target.instance, 10));
  if (target.nodeId !== undefined) lines.push(ui.kv(t('rpc.node'), target.nodeId, 10));
  return lines;
}

/** `vessel kanban list [--column X] [--owner Y] [--status Z] [--json]` */
export async function kanbanListCommand(options: KanbanListOptions = {}): Promise<CommandResult> {
  const params: Record<string, unknown> = {};
  if (options.column !== undefined && options.column !== '') params.column = options.column;
  if (options.owner !== undefined && options.owner !== '') params.owner = options.owner;
  if (options.status !== undefined && options.status !== '') params.status = options.status;
  const called = await callKanban(options, 'kanban.list', params);
  if (!called.ok) return called.error;
  const result = isRecord(called.result) ? called.result : {};

  if (options.json === true) {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }

  const rows = recordArray(result.tasks);
  const lines = targetLines(called.target);
  const total = typeof result.total === 'number' ? result.total : rows.length;
  const matched = typeof result.matched === 'number' ? result.matched : rows.length;
  lines.push(ui.kv(t('kanban.matched'), `${matched} / ${total}`, 10));
  const counts = isRecord(result.counts) ? result.counts : {};
  const countText = Object.entries(counts)
    .map(([column, count]) => `${column}=${count}`)
    .join('  ');
  if (countText !== '') lines.push(ui.kv(t('kanban.counts'), countText, 10));
  lines.push('', ui.section(`${t('kanban.tasks')} (${rows.length})`));
  if (rows.length === 0) {
    lines.push(`  ${ui.dim(t('kanban.empty'))}`);
  } else {
    const header = ['ID', 'COLUMN', 'OWNER', 'PROGRESS'];
    const cells = rows.map((row) => [
      pickString(row, 'id') ?? '?',
      pickString(row, 'column') ?? '?',
      pickString(row, 'owner') ?? '-',
      cap(pickString(row, 'progress_excerpt') ?? pickString(row, 'title') ?? ''),
    ]);
    const widths = header.map((name, index) =>
      Math.max(name.length, ...cells.map((cell) => (cell[index] ?? '').length)),
    );
    const line = (parts: string[]): string =>
      `  ${parts.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')}`;
    lines.push(ui.dim(line(header)));
    for (const cell of cells) lines.push(line(cell));
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  for (const warning of warnings) {
    if (typeof warning === 'string') lines.push(ui.dim(`⚠ ${warning}`));
  }
  lines.push('', ui.dim(t('kanban.viewHint')));
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

/** `vessel kanban view <id> [--json]` */
export async function kanbanViewCommand(
  id: string,
  options: KanbanViewOptions = {},
): Promise<CommandResult> {
  const called = await callKanban(options, 'kanban.view', { id });
  if (!called.ok) return called.error;
  const result = isRecord(called.result) ? called.result : {};

  if (options.json === true) {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }

  const task = isRecord(result.task) ? result.task : {};
  const lines = targetLines(called.target);
  lines.push('');
  lines.push(ui.kv('id', pickString(task, 'id') ?? id, 10));
  lines.push(ui.kv('title', pickString(task, 'title') ?? '-', 10));
  lines.push(ui.kv('column', pickString(task, 'column') ?? '-', 10));
  const owner = pickString(task, 'owner');
  if (owner !== undefined) lines.push(ui.kv('owner', owner, 10));
  const branch = pickString(task, 'branch');
  if (branch !== undefined) lines.push(ui.kv('branch', branch, 10));
  // 未知键也展示（view = 全字段详情）；progress 单独成段（全量不截断）。
  const known = new Set(['id', 'title', 'column', 'owner', 'branch', 'progress']);
  for (const [key, value] of Object.entries(task)) {
    if (known.has(key)) continue;
    lines.push(ui.kv(key, typeof value === 'string' ? value : JSON.stringify(value), 10));
  }
  const progress = pickString(task, 'progress');
  lines.push('', ui.section('progress'));
  lines.push(progress ?? ui.dim('-'));
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
