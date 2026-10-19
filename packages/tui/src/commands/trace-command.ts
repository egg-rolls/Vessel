/**
 * /trace —— 从 trace 查看 / 重放 run 事件
 * @module @vessel/tui
 *
 * 数据只来自 RPC `events.list`（E5/E6 消费端）：
 *   { run_id, since_seq?, since_ts?, types?, type_prefix?, limit? }
 * 返回按 (seq ?? ts) 升序；TUI 再做一次稳定排序兜底。
 * 事件已在服务端脱敏，TUI 展示前再过一层 redactForDisplay。
 */

import type { ReplContext } from '../repl-context.js';
import { formatRpcError, redactForDisplay } from '../rpc.js';
import { formatRelativeTime } from '../utils/time.js';
import type { TableView, ViewAction, ViewActionInvocation } from '../views/types.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE =
  'Usage: /trace show <run_id> [--limit <n>] [--since-seq <n>] [--type <prefix>|--types a,b] [--json]';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DATA_MAX = 160;
const STREAM_TYPES = new Set(['llm.stream.chunk']);

/** RunEvent 的结构子集（A-3 §10.3 / A-4 §11.1） */
export interface TraceEventLike {
  type: string;
  run_id?: string;
  data?: Record<string, unknown>;
  ts?: number;
  seq?: number;
  tenant_id?: string;
}

export interface TraceOptions {
  runId: string;
  limit: number;
  sinceSeq?: number;
  types?: string[];
  typePrefix?: string;
  json: boolean;
}

type ParseResult = { ok: true; value: TraceOptions } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

export function parseTraceArgs(args: string[]): ParseResult {
  const subcommand = args[0];
  if (subcommand !== 'show') return { ok: false, message: USAGE };

  const runId = args[1];
  if (runId === undefined || runId.length === 0 || runId.startsWith('--')) {
    return { ok: false, message: USAGE };
  }

  let limit = DEFAULT_LIMIT;
  let sinceSeq: number | undefined;
  let types: string[] | undefined;
  let typePrefix: string | undefined;
  let json = false;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--limit') {
      const value = parsePositiveInt(args[++i]);
      if (value === undefined || value > MAX_LIMIT) {
        return { ok: false, message: `--limit must be an integer between 1 and ${MAX_LIMIT}.` };
      }
      limit = value;
      continue;
    }
    if (arg === '--since-seq') {
      const value = parsePositiveInt(args[++i]);
      if (value === undefined) {
        return { ok: false, message: '--since-seq must be a positive integer.' };
      }
      sinceSeq = value;
      continue;
    }
    if (arg === '--type') {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        return { ok: false, message: '--type requires a prefix.' };
      }
      if (types) return { ok: false, message: '--type and --types are mutually exclusive.' };
      typePrefix = value;
      continue;
    }
    if (arg === '--types') {
      const value = args[++i];
      if (value === undefined) return { ok: false, message: '--types requires a comma list.' };
      if (typePrefix) return { ok: false, message: '--type and --types are mutually exclusive.' };
      types = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (types.length === 0) return { ok: false, message: '--types requires a comma list.' };
      continue;
    }
    return { ok: false, message: `${USAGE} (unknown argument "${arg}")` };
  }

  return {
    ok: true,
    value: {
      runId,
      limit,
      json,
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      ...(types ? { types } : {}),
      ...(typePrefix ? { typePrefix } : {}),
    },
  };
}

/** 接受 `[...]` 或 `{ events: [...] }`；忽略缺 type 的脏数据 */
export function readTraceEvents(value: unknown): TraceEventLike[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.events)
      ? value.events
      : [];

  return raw
    .filter(
      (item): item is Record<string, unknown> => isRecord(item) && typeof item.type === 'string',
    )
    .map((item) => ({
      type: item.type as string,
      ...(typeof item.run_id === 'string' ? { run_id: item.run_id } : {}),
      ...(isRecord(item.data) ? { data: item.data } : {}),
      ...(typeof item.ts === 'number' ? { ts: item.ts } : {}),
      ...(typeof item.seq === 'number' ? { seq: item.seq } : {}),
      ...(typeof item.tenant_id === 'string' ? { tenant_id: item.tenant_id } : {}),
    }));
}

function eventOrder(event: TraceEventLike): number {
  if (typeof event.seq === 'number') return event.seq;
  if (typeof event.ts === 'number') return event.ts;
  return Number.MAX_SAFE_INTEGER;
}

/** 稳定排序的兜底（服务端已按 (seq ?? ts) 返回） */
export function sortTraceEvents(events: TraceEventLike[]): TraceEventLike[] {
  return [...events].sort((a, b) => eventOrder(a) - eventOrder(b));
}

function summarizeData(event: TraceEventLike): string {
  const data = event.data;
  if (!data || Object.keys(data).length === 0) return '-';

  if (STREAM_TYPES.has(event.type)) {
    const chunk = data.delta ?? data.content ?? data.text;
    return typeof chunk === 'string' ? `chars=${chunk.length}` : '-';
  }

  try {
    return truncate(oneLine(JSON.stringify(redactForDisplay(data))), DATA_MAX);
  } catch {
    return '-';
  }
}

/** 纯函数：事件列表 */
export function formatTraceEvents(events: TraceEventLike[], now: number = Date.now()): string {
  if (events.length === 0) return 'No events.';

  const lines = [`Events (${events.length}, oldest first):`];
  for (const event of events) {
    const seq = typeof event.seq === 'number' ? `#${event.seq}` : '#-';
    const ts =
      typeof event.ts === 'number' && event.ts > 0 ? formatRelativeTime(event.ts, now) : '-';
    lines.push(
      `  ${seq.padEnd(8)} ${ts.padEnd(10)} ${event.type.padEnd(28)} ${summarizeData(event)}`.trimEnd(),
    );
  }
  return lines.join('\n');
}

/**
 * 视图上下文：把 trace 的查询参数编码进 `TableView.key`。
 * 刷新必须复用同一组过滤条件（run_id / limit / since-seq / type(s)）。
 */
export function encodeTraceViewKey(options: TraceOptions): string {
  return JSON.stringify({
    runId: options.runId,
    limit: options.limit,
    ...(options.sinceSeq !== undefined ? { sinceSeq: options.sinceSeq } : {}),
    ...(options.types ? { types: options.types } : {}),
    ...(options.typePrefix ? { typePrefix: options.typePrefix } : {}),
  });
}

/** 纯函数：解码视图上下文；非法/缺 run_id 返回 null */
export function decodeTraceViewKey(key: string | undefined): TraceOptions | null {
  if (!key) return null;
  try {
    const raw = JSON.parse(key) as Record<string, unknown>;
    if (typeof raw.runId !== 'string' || raw.runId.length === 0) return null;
    const limit =
      typeof raw.limit === 'number' && Number.isFinite(raw.limit)
        ? Math.min(Math.max(1, Math.floor(raw.limit)), MAX_LIMIT)
        : DEFAULT_LIMIT;
    return {
      runId: raw.runId,
      limit,
      json: false,
      ...(typeof raw.sinceSeq === 'number' && raw.sinceSeq > 0 ? { sinceSeq: raw.sinceSeq } : {}),
      ...(Array.isArray(raw.types)
        ? { types: raw.types.filter((item): item is string => typeof item === 'string') }
        : {}),
      ...(typeof raw.typePrefix === 'string' ? { typePrefix: raw.typePrefix } : {}),
    };
  } catch {
    return null;
  }
}

/** 纯函数：事件 -> TableView（seq/time/type/紧凑 data） */
export function buildTraceView(
  events: TraceEventLike[],
  options: TraceOptions,
  now: number = Date.now(),
): TableView {
  const rows = events.map((event, index) => ({
    key: typeof event.seq === 'number' ? `seq:${event.seq}` : `ts:${event.ts ?? 'none'}:${index}`,
    cells: {
      seq: typeof event.seq === 'number' ? `#${event.seq}` : '#-',
      time: typeof event.ts === 'number' && event.ts > 0 ? formatRelativeTime(event.ts, now) : '-',
      type: event.type,
      data: summarizeData(event),
    },
  }));

  return {
    kind: 'table',
    title: `Trace: ${options.runId}`,
    columns: [
      { key: 'seq', header: 'SEQ', width: 6, priority: 1 },
      { key: 'time', header: 'TIME', width: 10, priority: 1 },
      { key: 'type', header: 'TYPE', minWidth: 20, priority: 1 },
      { key: 'data', header: 'DATA', minWidth: 20, priority: 2 },
    ],
    rows,
    actions: traceActions(),
    ...(rows[0] ? { initialKey: rows[0].key } : {}),
    emptyText: `No events for run "${options.runId}".`,
    meta: `${events.length} events · oldest first`,
    key: encodeTraceViewKey(options),
  };
}

export function traceActions(): ViewAction[] {
  return [{ id: 'refresh', key: 'r', label: 'refresh' }];
}

type TraceFetch = { ok: true; events: TraceEventLike[] } | { ok: false; message: string };

/** events.list 读取（命令主体与视图刷新共用；错误文本与既有命令一致） */
async function fetchTraceEvents(ctx: ReplContext, options: TraceOptions): Promise<TraceFetch> {
  if (!ctx.rpc) {
    return {
      ok: false,
      message:
        'RPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to read traces.',
    };
  }

  const params: Record<string, unknown> = { run_id: options.runId, limit: options.limit };
  if (options.sinceSeq !== undefined) params.since_seq = options.sinceSeq;
  if (options.types) params.types = options.types;
  if (options.typePrefix) params.type_prefix = options.typePrefix;

  try {
    const raw = await ctx.rpc.request<unknown>('events.list', params);
    return { ok: true, events: sortTraceEvents(readTraceEvents(raw)) };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to read trace for run "${options.runId}":\n${formatRpcError(error)}`,
    };
  }
}

/** `/trace` 视图动作：r 用同一组查询参数刷新 */
export async function runTraceViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  if (invocation.actionId !== 'refresh') {
    return {
      handled: true,
      output: `\nUnknown /trace view action "${invocation.actionId}".\n`,
    };
  }
  const options = decodeTraceViewKey(invocation.viewKey);
  if (!options) {
    return {
      handled: true,
      output: '\nTrace view is missing its run context; reopen /trace show <run_id>.\n',
    };
  }
  const fetched = await fetchTraceEvents(ctx, options);
  if (!fetched.ok) return { handled: true, output: `\n${fetched.message}\n` };
  return {
    handled: true,
    view: { source: 'trace', view: buildTraceView(fetched.events, options) },
  };
}

/** /trace 的执行体（导出供单测） */
export async function runTraceCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const parsed = parseTraceArgs(args);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };
  const options = parsed.value;

  const fetched = await fetchTraceEvents(ctx, options);
  if (!fetched.ok) {
    return { handled: true, output: `\n${fetched.message}\n` };
  }
  const events = fetched.events;

  // JSON 是机器可读出口：保持纯文本，不返回 view。
  if (options.json) {
    return {
      handled: true,
      output: `\n${JSON.stringify(redactForDisplay(events), null, 2)}\n`,
    };
  }
  if (events.length === 0) {
    return {
      handled: true,
      output: `\nNo events for run "${options.runId}".\n`,
      view: { source: 'trace', view: buildTraceView(events, options) },
    };
  }
  return {
    handled: true,
    output: `\n${formatTraceEvents(events)}\n`,
    view: { source: 'trace', view: buildTraceView(events, options) },
  };
}

export function traceCommand(): CommandEntry {
  return {
    name: 'trace',
    description: 'Show run events from trace (replay)',
    usage: '/trace show <run_id> [--limit <n>] [--since-seq <n>] [--type <prefix>] [--json]',
    category: 'inspect',
    keywords: ['events', 'replay'],
    available: (ctx) => Boolean(ctx.rpc),
    unavailableHint: 'RPC required',
    run: (args, ctx) => runTraceCommand(args, ctx),
    viewAction: (invocation, ctx) => runTraceViewAction(invocation, ctx),
  };
}
