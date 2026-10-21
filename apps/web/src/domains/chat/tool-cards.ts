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
}

export type ChatRenderItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'reasoning'; text: string; key: string; startedAt?: number; endedAt?: number }
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

/** Codex 式关键参数摘要：bash 命令行首行、路径、pattern、delegate task。 */
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
      delegate_task: ['task', 'prompt'],
    };
    value =
      scalarArg(parsed, byTool[name] ?? []) ??
      scalarArg(parsed, ['command', 'path', 'pattern', 'query', 'task', 'url', 'name']) ??
      Object.values(parsed)
        .find(
          (item): item is string | number =>
            (typeof item === 'string' && item.trim().length > 0) ||
            (typeof item === 'number' && Number.isFinite(item)),
        )
        ?.toString();
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
  const totalLines = text === '' ? 0 : text.split('\n').length;
  const byLines = text.split('\n').slice(0, maxLines).join('\n');
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
