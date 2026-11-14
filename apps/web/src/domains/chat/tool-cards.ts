import type { RunEvent } from '../../gateway/types';
import { type ErrorMeta, errorMetaOf } from '../../state/error-visibility';
import type { TimelineItem } from '../../state/events';

export type ToolCardStatus = 'running' | 'done' | 'error';

export interface ToolCardView {
  kind: 'tool';
  key: string;
  callId?: string;
  name: string;
  status: ToolCardStatus;
  args?: unknown;
  result?: unknown;
  error?: string;
  /** 0.14 additive：tool.call.failed 的结构化错误元数据。 */
  errorMeta?: ErrorMeta;
  durationMs?: number;
  truncated?: boolean;
  startedAt: number;
  /**
   * 该卡解析到的事件锚点（`tool.call.started` 的 seq）。
   *
   * 只用于诊断与门禁对拍（交棒记录 / 守恒断言要按锚点对账）；渲染不读它。
   * 工具卡**不走交棒**（历史侧不复现执行态耗时与截断标记），所以它允许缺省。
   */
  anchorSeq?: number;
}

export type ChatRenderItem =
  | { kind: 'text'; text: string; key: string; startedAt?: number; endedAt?: number }
  | { kind: 'reasoning'; text: string; key: string; startedAt?: number; endedAt?: number }
  | { kind: 'notice'; event: RunEvent; key: string }
  | { kind: 'event'; event: RunEvent; key: string }
  | ToolCardView;

interface PendingStart {
  card: ToolCardView;
  callId?: string;
}

function callIdOf(data: Record<string, unknown>): string | undefined {
  const id = data.tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function toolNameOf(data: Record<string, unknown>): string | undefined {
  const name = data.tool_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function durationOf(data: Record<string, unknown>): number | undefined {
  const value = data.duration_ms;
  return typeof value === 'number' ? value : undefined;
}

function errorOf(data: Record<string, unknown>): string | undefined {
  const value = data.error;
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  return String(value);
}

function takePending(
  pending: PendingStart[],
  callId: string | undefined,
  name: string | undefined,
): PendingStart | undefined {
  if (callId !== undefined) {
    const exact = pending.findIndex((entry) => entry.callId === callId);
    if (exact >= 0) return pending.splice(exact, 1)[0];
  }
  if (name === undefined) return undefined;
  // Distinct call ids must never be merged through the name fallback.
  const fallback = pending.findIndex(
    (entry) => entry.card.name === name && (callId === undefined || entry.callId === undefined),
  );
  return fallback >= 0 ? pending.splice(fallback, 1)[0] : undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 优先把 arguments 解析成对象；解析失败时按原始字符串处理。 */
export function parseToolArgs(args: unknown): Record<string, unknown> | string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed.startsWith('{')) return args;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : args;
    } catch {
      return args;
    }
  }
  if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return stringifyValue(args);
}

function scalarArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

type ToolArgs = Record<string, unknown>;

/** 结构化入参工具的摘要：`action → 目标/条数`。 */
type StructuredSummarizer = (args: ToolArgs) => string | undefined;

function isRecord(value: unknown): value is ToolArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 首个非空短文本：压成单行并按 cap 截断（摘要不是正文）。 */
function shortText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function intValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** 数组长度；非数组 → undefined（不猜）。 */
function listLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

/** 数组里的非空字符串成员（`members` / `paths` / `ids` 用）。 */
function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

/** `<principal>@<node_id>:<team_id>` 只留 principal —— 卡头说的是「发给谁」，不是完整路由。 */
function principalLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

/**
 * `agent`：`action` + 目标 / 人数 / 条数。
 *
 * 入参见 `packages/agent/src/tool.ts:339`（`action` 首位必填，目标散在
 * `to` / `member` / `members[]` / `name`）：这些都是结构化字段，旧实现只在标量名单里
 * 找 → 卡片头部只剩工具名。
 */
function agentSummary(args: ToolArgs): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'create' || action === 'hire') {
    const count = listLength(args.members);
    const name = shortText(args.name, 48);
    if (count !== undefined && count > 1) return `${action} → ${count} 名成员`;
    if (name !== undefined) return `${action} → ${name}`;
    if (count === 1) return `${action} → 1 名成员`;
    return action;
  }
  const target = principalLabel(
    shortText(args.to, 64) ??
      shortText(args.member, 64) ??
      stringItems(args.members)[0] ??
      shortText(args.name, 64),
  );
  const head = target === undefined ? action : `${action} → ${target}`;
  // 只报条数：`messages` 的正文不进摘要。
  const messages = listLength(args.messages);
  if (messages !== undefined && messages > 0) return `${head}（${messages} 条）`;
  const closing = action === 'close' ? stringItems(args.members).length : 0;
  if (closing > 1) return `${head}（共 ${closing} 名）`;
  return head;
}

/**
 * `inbox`：`action` + 条数 / 首个 id / 正文首段。
 *
 * 入参见 `packages/agent/src/inbox.ts:1185`（`ids` / `message_ids` / `limit` / `content`）。
 */
function inboxSummary(args: ToolArgs): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'insert') {
    const content = shortText(args.content, 40);
    return content === undefined ? action : `${action} → ${content}`;
  }
  const ids = [...stringItems(args.ids), ...stringItems(args.message_ids)];
  const first = ids[0];
  if (first !== undefined) {
    return ids.length === 1 ? `${action} → ${first.slice(0, 48)}` : `${action} → ${ids.length} 条`;
  }
  const limit = intValue(args.limit);
  if (limit !== undefined && limit > 0) return `${action} → 最多 ${limit} 条`;
  return action;
}

/** `subscribe`：`action` + 文件 / 订阅 id（入参见 `plugins/context/doc-subscription/src/tool.ts:450`）。 */
function subscribeSummary(args: ToolArgs): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'list') return action;
  const single = shortText(args.path, 96);
  const many = stringItems(args.paths);
  const paths = single === undefined ? many : [single, ...many];
  const first = paths[0];
  if (first === undefined) {
    const id = shortText(args.id, 48);
    return id === undefined ? action : `${action} → ${id}`;
  }
  return paths.length === 1
    ? `${action} → ${first}`
    : `${action} → ${paths.length} 个文件（${first} 等）`;
}

/** `ask`：首个问题标题（`header`）+ 问题数（入参见 `packages/tui/src/renderer/ask-user.ts:372`）。 */
function askSummary(args: ToolArgs): string | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const total = questions.length;
  if (total === 0) return undefined;
  const first = questions[0];
  const label = isRecord(first)
    ? (shortText(first.header, 24) ?? shortText(first.question, 32))
    : undefined;
  if (label === undefined) return `ask → ${total} 个问题`;
  return total > 1 ? `ask → ${label}（共 ${total} 个问题）` : `ask → ${label}`;
}

/**
 * 结构化入参工具的专用摘要（**优先于**下面的标量名单）。
 *
 * 这些工具的首个必填参数是 `action`，目标 / 条数是结构化字段（`to` / `members[]` /
 * `messages[]` / `ids[]` / `paths[]` / `questions[]`），一个都不在 `KNOWN_ARG_NAMES`
 * 里 —— 旧实现因此让 `agent` / `inbox` 卡片丢掉整段参数摘要。这里只取计数与首个短
 * 字段，不展开正文，也不回退到 `Object.values` 全盘扫。返回 `undefined` 表示「这个
 * 工具这一份入参没有结构化摘要」，照旧走下面的标量兜底。
 */
const STRUCTURED_ARG_SUMMARIES: Record<string, StructuredSummarizer> = {
  agent: agentSummary,
  inbox: inboxSummary,
  subscribe: subscribeSummary,
  ask: askSummary,
};

/** 摘要行允许用于兜底的已知参数名（不含 serve 注入的 preview / truncated）。 */
const KNOWN_ARG_NAMES: readonly string[] = [
  'command',
  'cmd',
  'script',
  'path',
  'file_path',
  'pattern',
  'query',
  'regex',
  'task',
  'prompt',
  'url',
  'name',
];

/** Codex 式关键参数摘要：bash 命令行首行、路径、pattern。 */
export function toolSummary(name: string, args: unknown, maxLength = 96): string {
  const parsed = parseToolArgs(args);
  if (parsed === undefined) return '';
  let value: string | undefined;
  if (typeof parsed === 'string') {
    value = parsed;
  } else {
    const byTool: Record<string, readonly string[]> = {
      bash: ['command', 'cmd', 'script'],
      read: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      write: ['path', 'file_path'],
      grep: ['pattern', 'query', 'regex'],
      search: ['query', 'pattern'],
    };
    value =
      STRUCTURED_ARG_SUMMARIES[name]?.(parsed) ??
      scalarArg(parsed, byTool[name] ?? []) ??
      scalarArg(parsed, ['command', 'path', 'pattern', 'query', 'task', 'url', 'name']) ??
      // 兜底只在**已知参数名**里找：`Object.values` 会把 serve 截断后塞进来的
      // `preview` / `truncated` 当成摘要（摘要行显示预览文本，看着像别的工具的东西）。
      scalarArg(parsed, KNOWN_ARG_NAMES);
  }
  if (!value) return '';
  // bash 只取首行；其它工具把换行压成空格，避免 header 被撑高。
  const compact = name === 'bash' ? (value.split('\n')[0] ?? '') : value.replace(/\s+/g, ' ');
  const text = compact.trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface EditDiff {
  path?: string;
  lines: DiffLine[];
  truncated: boolean;
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

/**
 * `edit` 的 old_string/new_string → 行级 diff。
 * 先掐掉公共前缀/后缀，只展示变更块与 2 行上下文；不做 O(n²) LCS。
 */
export function editDiffOf(
  args: unknown,
  { context = 2, maxLines = 200 }: { context?: number; maxLines?: number } = {},
): EditDiff | null {
  const parsed = parseToolArgs(args);
  if (!parsed || typeof parsed === 'string') return null;
  const oldValue = parsed.old_string;
  const newValue = parsed.new_string;
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return null;

  const oldLines = splitLines(oldValue);
  const newLines = splitLines(newValue);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  for (const text of oldLines.slice(Math.max(0, prefix - context), prefix)) {
    lines.push({ kind: 'context', text });
  }
  for (const text of oldLines.slice(prefix, oldLines.length - suffix)) {
    lines.push({ kind: 'remove', text });
  }
  for (const text of newLines.slice(prefix, newLines.length - suffix)) {
    lines.push({ kind: 'add', text });
  }
  for (const text of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + context)) {
    lines.push({ kind: 'context', text });
  }

  const changed = oldValue !== newValue;
  if (!changed) return null;
  const truncated = lines.length > maxLines;
  return {
    ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
    lines: truncated ? lines.slice(0, maxLines) : lines,
    truncated,
  };
}

export const PREVIEW_LINES = 20;
export const PREVIEW_BYTES = 8 * 1024;
export const PAYLOAD_CHUNK_BYTES = 200 * 1024;

export interface PayloadPreview {
  preview: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

/** 折叠态预览：最多 20 行 / 8KB；保留原始换行与行首空格。 */
export function previewPayload(
  text: string,
  maxLines = PREVIEW_LINES,
  maxBytes = PREVIEW_BYTES,
): PayloadPreview {
  // 只 split 一次：以前对大 payload 会切两遍数组（512KiB 时每卡每渲染 ~1ms）。
  const lines = text === '' ? [] : text.split('\n');
  const totalLines = lines.length;
  const byLines = lines.slice(0, maxLines).join('\n');
  const preview = byLines.length > maxBytes ? byLines.slice(0, maxBytes) : byLines;
  return {
    preview,
    truncated: totalLines > maxLines || text.length > preview.length,
    totalLines,
    totalBytes: text.length,
  };
}

export function foldToolItems(items: readonly TimelineItem[]): ChatRenderItem[] {
  const output: ChatRenderItem[] = [];
  const pending: PendingStart[] = [];

  for (const item of items) {
    if (item.kind !== 'event') {
      output.push(item);
      continue;
    }

    const { event } = item;
    if (event.type === 'tool.call.started') {
      const callId = callIdOf(event.data);
      const card: ToolCardView = {
        kind: 'tool',
        key: item.key,
        callId,
        name: toolNameOf(event.data) ?? 'tool',
        status: 'running',
        args: event.data.arguments,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      };
      output.push(card);
      pending.push({ card, callId });
      continue;
    }

    if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      const completed = event.type === 'tool.call.completed';
      const callId = callIdOf(event.data);
      const name = toolNameOf(event.data);
      const durationMs = durationOf(event.data);
      const started = takePending(pending, callId, name);

      if (started) {
        started.card.status = completed ? 'done' : 'error';
        if (started.card.callId === undefined && callId !== undefined) {
          started.card.callId = callId;
        }
        if (completed) started.card.result = event.data.result;
        else {
          started.card.error = errorOf(event.data);
          started.card.errorMeta = errorMetaOf(event.data);
        }
        if (durationMs !== undefined) started.card.durationMs = durationMs;
        if (event.data.truncated === true) started.card.truncated = true;
        continue;
      }

      output.push({
        kind: 'tool',
        key: `tool-${item.key}`,
        callId,
        name: name ?? 'tool',
        status: completed ? 'done' : 'error',
        result: completed ? event.data.result : undefined,
        error: completed ? undefined : errorOf(event.data),
        errorMeta: completed ? undefined : errorMetaOf(event.data),
        durationMs,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      });
      continue;
    }

    output.push(item);
  }

  return output;
}
