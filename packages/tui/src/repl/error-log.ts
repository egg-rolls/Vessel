/**
 * `/errors` 最近错误收集（0.14 P0）。
 * @module @vessel-agent/tui
 *
 * 只读进程内事件历史，不读 trace、不调 RPC。
 * - user 级：run / tool / guardrail / 子 agent 失败 + 用户拒绝的权限请求；
 * - internal 级：process / shutdown / hook / plugin / agent / context / llm / trace / session
 *   的 `.error` / `.failed`，默认隐藏。
 */

import type { RunEvent } from '@vessel-agent/core';

export type ErrorLevel = 'user' | 'all';

export type ErrorEntryKind = 'error' | 'permissionDenied';

export interface ErrorLogEntry {
  ts: number;
  type: string;
  level: 'user' | 'internal';
  kind: ErrorEntryKind;
  runId?: string;
  sessionId?: string;
  tool?: string;
  message: string;
  errorCode?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
}

export interface CollectErrorsOptions {
  /** true = 追加 internal 级错误 */
  includeInternal: boolean;
  /** 默认 10；倒序截断 */
  limit?: number;
}

export const DEFAULT_ERROR_LIMIT = 10;

const USER_ERROR_TYPES = new Set([
  'run.failed',
  'tool.call.failed',
  'guardrail.blocked',
  'error',
  'subagent.run.failed',
  'subagent.tool.call.failed',
  'subagent.delegate.failed',
]);

const INTERNAL_ERROR_PREFIXES = [
  'process.',
  'shutdown.',
  'hook.',
  'plugin.',
  'agent.',
  'context.',
  'llm.',
  'trace.',
  'session.',
  'mcp.',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(event: RunEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function readString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readBoolean(data: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** 去掉重复 `subagent.` 前缀，用于类型分类 */
function baseType(type: string): string {
  let value = type;
  while (value.startsWith('subagent.')) value = value.slice('subagent.'.length);
  return value;
}

function isInternalError(type: string): boolean {
  if (USER_ERROR_TYPES.has(type)) return false;
  const base = baseType(type);
  if (!/\.(?:error|failed|failure)$/.test(base)) return false;
  return INTERNAL_ERROR_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function messageOf(data: Record<string, unknown>): string {
  const raw = data.error ?? data.message ?? data.reason;
  if (typeof raw === 'string') return raw.trim();
  if (raw instanceof Error) return raw.message;
  if (isRecord(raw)) {
    const nested = raw.message ?? raw.error;
    if (typeof nested === 'string') return nested.trim();
  }
  return '';
}

function toEntry(event: RunEvent, level: 'user' | 'internal'): ErrorLogEntry | null {
  const data = dataOf(event);
  const type = event.type;
  const base = baseType(type);

  if (type === 'tool.permission.response') {
    if (level !== 'user') return null;
    const decision = readString(data, 'decision');
    if (decision !== 'deny') return null;
    return {
      ts: event.ts,
      type,
      level,
      kind: 'permissionDenied',
      runId: event.run_id,
      message: '',
    };
  }

  const userLevel = USER_ERROR_TYPES.has(type) || USER_ERROR_TYPES.has(base);
  const internalLevel = isInternalError(type);
  if (level === 'user' && !userLevel) return null;
  if (level === 'internal' && !internalLevel) return null;

  const message = messageOf(data);
  if (message.length === 0) return null;

  const sessionId = readString(data, 'session_id');
  const tool = readString(data, 'tool_name', 'tool');
  const errorCode = readString(data, 'error_code', 'errorCode', 'code');
  const category = readString(data, 'category');
  const phase = readString(data, 'phase');
  const retryable = readBoolean(data, 'retryable');

  return {
    ts: event.ts,
    type,
    level: internalLevel ? 'internal' : 'user',
    kind: 'error',
    runId: event.run_id,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(tool !== undefined ? { tool } : {}),
    message,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

/**
 * 纯函数：按时间顺序扫描历史，收集错误并按 ts 倒序截断。
 * permission deny 的工具名由之前的 request 事件映射（requestId 配对）。
 */
export function collectRecentErrors(
  events: RunEvent[],
  options: CollectErrorsOptions,
): ErrorLogEntry[] {
  const limit = options.limit ?? DEFAULT_ERROR_LIMIT;
  const permissionTools = new Map<string, string>();
  const entries: ErrorLogEntry[] = [];

  for (const event of events) {
    const data = dataOf(event);
    const requestId = readString(data, 'requestId', 'request_id');
    if (event.type === 'tool.permission.request' && requestId !== undefined) {
      const tool = readString(data, 'tool', 'tool_name');
      if (tool !== undefined) permissionTools.set(requestId, tool);
    }

    const user = toEntry(event, 'user');
    if (user) {
      if (user.kind === 'permissionDenied' && requestId !== undefined) {
        const tool = permissionTools.get(requestId);
        if (tool !== undefined) user.tool = tool;
      }
      entries.push(user);
    }

    if (options.includeInternal) {
      const internal = toEntry(event, 'internal');
      if (internal) entries.push(internal);
    }
  }

  return entries
    .sort((a, b) => {
      if (a.ts !== b.ts) return b.ts - a.ts;
      return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
    })
    .slice(0, limit);
}
