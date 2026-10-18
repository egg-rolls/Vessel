/**
 * /sessions —— 会话列表 / 删除 / 重命名（0.5 file 后端）
 * @module @vessel/tui
 *
 * 数据与写操作都走 RPC：`sessions.list` / `sessions.get` / `sessions.delete` /
 * `sessions.rename`（E4 消费端）；无 RpcClient 的第三方嵌入退回 ctx.session。
 * delete 底层是 core `deleteSessionData`，active run 时返回 conflict（A-4 §11.3）。
 */

import type { SessionInfo } from '@vessel/core';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /sessions [list | delete <id> --yes | rename <id> <title>]';
const SESSION_WIDTH = 28;
const MESSAGES_WIDTH = 8;
const UPDATED_WIDTH = 10;

/** sessions.get 的最小形状 */
export interface SessionStateLike {
  session_id?: string;
  messages: Array<{ role: string; content: string }>;
}

/** delete 计数（A-4 §11.3；1 追加 sessions_deleted） */
export interface SessionDeleteResultLike {
  sessions_deleted?: number;
  runs_deleted?: number;
  events_deleted?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readSessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value) || typeof value.session_id !== 'string') return null;
  return {
    session_id: value.session_id,
    title: asString(value.title, '(untitled)'),
    preview: asString(value.preview),
    status: asString(value.status, '-'),
    started_at: asNumber(value.started_at),
    updated_at: asNumber(value.updated_at),
    message_count: asNumber(value.message_count),
    ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
  };
}

function readSessionList(value: unknown): SessionInfo[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : [];
  return raw.map(readSessionInfo).filter((session): session is SessionInfo => session !== null);
}

/** 排序：updated_at 倒序，同值 session_id 升序 */
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.session_id === b.session_id) return 0;
    return a.session_id < b.session_id ? -1 : 1;
  });
}

function readMessages(value: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is Record<string, unknown> => isRecord(message))
    .map((message) => ({
      role: asString(message.role, 'unknown'),
      content: asString(message.content),
    }));
}

/** 读取会话列表：RPC 优先，第三方嵌入退回 SessionBackend */
export async function listSessions(ctx: ReplContext): Promise<SessionInfo[]> {
  if (ctx.rpc) {
    const raw = await ctx.rpc.request<unknown>('sessions.list');
    return sortSessions(readSessionList(raw));
  }
  return sortSessions(await ctx.session.listRich());
}

/** 读取单个会话：RPC 优先，第三方嵌入退回 SessionBackend */
export async function getSessionState(
  ctx: ReplContext,
  sessionId: string,
): Promise<SessionStateLike | null> {
  if (ctx.rpc) {
    try {
      const raw = await ctx.rpc.request<unknown>('sessions.get', { session_id: sessionId });
      const wrapped = isRecord(raw) && isRecord(raw.session) ? raw.session : raw;
      if (!isRecord(wrapped)) return null;
      return { session_id: sessionId, messages: readMessages(wrapped.messages) };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if ((error as { code?: unknown }).code === 'not_found') return null;
      }
      throw error;
    }
  }

  const loaded = await ctx.session.load(sessionId);
  if (!loaded) return null;
  return { session_id: sessionId, messages: readMessages(loaded.messages) };
}

function readDeleteResult(value: unknown): SessionDeleteResultLike {
  if (!isRecord(value)) return {};
  const result: SessionDeleteResultLike = {};
  if (typeof value.sessions_deleted === 'number') result.sessions_deleted = value.sessions_deleted;
  if (typeof value.runs_deleted === 'number') result.runs_deleted = value.runs_deleted;
  if (typeof value.events_deleted === 'number') result.events_deleted = value.events_deleted;
  return result;
}

/** 删除会话：RPC 优先，第三方嵌入退回 SessionBackend */
export async function deleteSession(
  ctx: ReplContext,
  sessionId: string,
): Promise<SessionDeleteResultLike> {
  if (ctx.rpc) {
    const raw = await ctx.rpc.request<unknown>('sessions.delete', { session_id: sessionId });
    return readDeleteResult(raw);
  }
  await ctx.session.delete(sessionId);
  return {};
}

function formatDeleteCounts(counts: SessionDeleteResultLike): string {
  const parts: string[] = [];
  if (counts.sessions_deleted !== undefined) parts.push(`sessions: ${counts.sessions_deleted}`);
  if (counts.runs_deleted !== undefined) parts.push(`runs: ${counts.runs_deleted}`);
  if (counts.events_deleted !== undefined) parts.push(`events: ${counts.events_deleted}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** 纯函数：会话表格 */
export function formatSessions(
  sessions: SessionInfo[],
  currentSessionId: string,
  now: number = Date.now(),
): string {
  if (sessions.length === 0) return 'No sessions.';

  const lines = ['', `Sessions (${sessions.length}, newest first):`];
  lines.push(
    `  ${'SESSION'.padEnd(SESSION_WIDTH)} ${'MESSAGES'.padEnd(
      MESSAGES_WIDTH,
    )} ${'UPDATED'.padEnd(UPDATED_WIDTH)} TITLE`,
  );
  for (const session of sessions) {
    const marker = session.session_id === currentSessionId ? '*' : ' ';
    const updated = session.updated_at > 0 ? formatRelativeTime(session.updated_at, now) : '-';
    const title = session.title || session.preview || '-';
    lines.push(
      `${marker} ${session.session_id.padEnd(SESSION_WIDTH)} ${String(session.message_count).padEnd(
        MESSAGES_WIDTH,
      )} ${updated.padEnd(UPDATED_WIDTH)} ${title}`.trimEnd(),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function usage(message: string = USAGE): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

/** /sessions 的执行体（导出供单测） */
export async function runSessionsCommand(
  args: string[],
  ctx: ReplContext,
  currentSessionId: string,
): Promise<CommandResult> {
  const [subcommand, target, ...rest] = args;

  if (subcommand === undefined || subcommand === 'list') {
    if (target !== undefined) return usage();
    try {
      return {
        handled: true,
        output: formatSessions(await listSessions(ctx), currentSessionId),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to list sessions:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'delete') {
    if (target === undefined) return usage('Usage: /sessions delete <id> --yes');
    const confirmed = rest.includes('--yes');
    const extra = rest.filter((arg) => arg !== '--yes');
    if (extra.length > 0) return usage('Usage: /sessions delete <id> --yes');

    if (target === currentSessionId) {
      return usage(`Refusing to delete the current session "${target}"; run /new first.`);
    }
    if (!confirmed) {
      return usage(`Will delete session "${target}" and its runs/events. Add --yes to confirm.`);
    }

    try {
      const counts = await deleteSession(ctx, target);
      return {
        handled: true,
        output: `\nDeleted session "${target}".${formatDeleteCounts(counts)}\n`,
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to delete session "${target}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'rename') {
    const title = rest.join(' ').trim();
    if (target === undefined || title.length === 0) {
      return usage('Usage: /sessions rename <id> <title>');
    }
    if (!ctx.rpc) {
      return usage('Renaming sessions requires the RPC control plane.');
    }
    try {
      await ctx.rpc.request('sessions.rename', { session_id: target, title });
      return { handled: true, output: `\nRenamed session "${target}" to "${title}".\n` };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to rename session "${target}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  return usage();
}

export function sessionsCommand(): CommandEntry {
  return {
    name: 'sessions',
    description: 'List / delete / rename sessions',
    usage: '/sessions [list | delete <id> --yes | rename <id> <title>]',
    run: (args, ctx, state) => runSessionsCommand(args, ctx, state.currentSessionId),
  };
}
