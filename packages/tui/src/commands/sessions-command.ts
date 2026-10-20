/**
 * /sessions —— 会话列表 / 删除 / 重命名（0.5 file 后端）
 * @module @vessel-agent/tui
 *
 * 数据与写操作都走 RPC：`sessions.list` / `sessions.get` / `sessions.delete` /
 * `sessions.rename`（E4 消费端）；无 RpcClient 的第三方嵌入退回 ctx.session。
 * delete 底层是 core `deleteSessionData`，active run 时返回 conflict（A-4 §11.3）。
 */

import type { SessionInfo } from '@vessel-agent/core';
import { t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { padToWidth, truncateToWidth } from '../utils/text-layout.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /resume [number|id|delete <id> --yes|rename <id> <title>]';
const DEPRECATION = '/sessions is deprecated; use /resume (picker: r rename, x delete).';
const SESSION_WIDTH = 28;
const MESSAGES_WIDTH = 8;
const UPDATED_WIDTH = 10;
const TITLE_MAX = 48;

/** 历史展示需要的消息形状（tool_calls/reasoning 可选，旧会话缺失时降级） */
export interface SessionMessageLike {
  role: string;
  content: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

/** sessions.get 的最小形状 */
export interface SessionStateLike {
  session_id?: string;
  messages: SessionMessageLike[];
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

function readToolCalls(
  value: unknown,
): Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value
    .filter((call): call is Record<string, unknown> => isRecord(call))
    .map((call) => {
      const fn = isRecord(call.function) ? call.function : {};
      return {
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        function: {
          ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
          ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
        },
      };
    });
  return calls.length > 0 ? calls : undefined;
}

function readMessages(value: unknown): SessionMessageLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is Record<string, unknown> => isRecord(message))
    .map((message) => {
      const toolCalls = readToolCalls(message.tool_calls);
      return {
        role: asString(message.role, 'unknown'),
        content: asString(message.content),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
        ...(typeof message.name === 'string' ? { name: message.name } : {}),
        ...(typeof message.reasoning_content === 'string'
          ? { reasoning_content: message.reasoning_content }
          : {}),
      };
    });
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
  if (sessions.length === 0) return t('empty.sessions');

  const lines = ['', `Sessions (${sessions.length}, newest first):`];
  const header = `  ${padToWidth('SESSION', SESSION_WIDTH)} ${padToWidth(
    'MESSAGES',
    MESSAGES_WIDTH,
  )} ${padToWidth('UPDATED', UPDATED_WIDTH)} TITLE`;
  lines.push(header.trimEnd());
  for (const session of sessions) {
    const marker = session.session_id === currentSessionId ? '*' : ' ';
    const updated = session.updated_at > 0 ? formatRelativeTime(session.updated_at, now) : '-';
    const title = truncateToWidth(session.title || session.preview || '-', TITLE_MAX);
    lines.push(
      `${marker} ${padToWidth(
        truncateToWidth(session.session_id, SESSION_WIDTH),
        SESSION_WIDTH,
      )} ${padToWidth(String(session.message_count), MESSAGES_WIDTH)} ${padToWidth(
        updated,
        UPDATED_WIDTH,
      )} ${title}`.trimEnd(),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function usage(message: string = USAGE): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

export interface DeleteSessionOptions {
  /** 必须显式确认；非交互删除绝不能默认确认 */
  confirmed: boolean;
  /** 当前会话 ID；命中时拒绝删除 */
  currentSessionId?: string;
}

/**
 * 删除会话（/resume delete 与 deprecated /sessions delete 共用）。
 * 纯函数：只返回 CommandResult，不发 UI 事件。
 */
export async function deleteSessionAction(
  ctx: ReplContext,
  sessionId: string,
  options: DeleteSessionOptions,
): Promise<CommandResult> {
  if (options.currentSessionId && sessionId === options.currentSessionId) {
    return usage(`Refusing to delete the current session "${sessionId}"; run /new first.`);
  }
  if (!options.confirmed) {
    return usage(`Will delete session "${sessionId}" and its runs/events. Add --yes to confirm.`);
  }

  try {
    const counts = await deleteSession(ctx, sessionId);
    return {
      handled: true,
      output: `\nDeleted session "${sessionId}".${formatDeleteCounts(counts)}\n`,
    };
  } catch (error) {
    return {
      handled: true,
      output: `\n${t('error.command.deleteSession', { id: sessionId })}\n${formatRpcError(error)}\n`,
    };
  }
}

/**
 * 重命名会话（/resume rename 与 deprecated /sessions rename 共用）。
 * 空标题直接拒绝；重命名需要 RPC 控制面。
 */
export async function renameSessionAction(
  ctx: ReplContext,
  sessionId: string,
  title: string,
): Promise<CommandResult> {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return usage('Usage: /resume rename <id> <title>');
  }
  if (!ctx.rpc) {
    return usage('Renaming sessions requires the RPC control plane.');
  }
  try {
    await ctx.rpc.request('sessions.rename', { session_id: sessionId, title: trimmed });
    return {
      handled: true,
      output: `\nRenamed session "${sessionId}" to "${trimmed}".\n`,
    };
  } catch (error) {
    return {
      handled: true,
      output: `\n${t('error.command.renameSession', { id: sessionId })}\n${formatRpcError(error)}\n`,
    };
  }
}

/**
 * /sessions 的执行体（deprecated alias，导出供单测）。
 * `delete` / `rename` 转调共享 action；`list` 转调 /resume 的选择器状态。
 */
export async function runSessionsCommand(
  args: string[],
  ctx: ReplContext,
  currentSessionId: string,
): Promise<CommandResult> {
  const [subcommand, target, ...rest] = args;

  if (subcommand === undefined || subcommand === 'list') {
    if (target !== undefined) return usage();
    return {
      handled: true,
      output: '\nResume which session? Enter its number:\n',
      nextState: { showResumePicker: true, pendingResume: true },
    };
  }

  if (subcommand === 'delete') {
    if (target === undefined) return usage('Usage: /resume delete <id> --yes');
    const confirmed = rest.includes('--yes');
    const extra = rest.filter((arg) => arg !== '--yes');
    if (extra.length > 0) return usage('Usage: /resume delete <id> --yes');
    return deleteSessionAction(ctx, target, { confirmed, currentSessionId });
  }

  if (subcommand === 'rename') {
    const title = rest.join(' ').trim();
    if (target === undefined || title.length === 0) {
      return usage('Usage: /resume rename <id> <title>');
    }
    return renameSessionAction(ctx, target, title);
  }

  return usage();
}

/** /sessions 是 /resume 的 hidden deprecated alias（0.7 删除） */
export function sessionsCommand(): CommandEntry {
  return {
    name: 'sessions',
    description: t('command.sessions.description'),
    usage: '/sessions (deprecated; use /resume)',
    category: 'session',
    hidden: true,
    run: async (args, ctx, state) => {
      const result = await runSessionsCommand(args, ctx, state.currentSessionId);
      return {
        ...result,
        output: `${DEPRECATION}\n${result.output ?? ''}`.trimEnd(),
      };
    },
  };
}

/**
 * 把 action 的文本结果归一为 UI 可消费的 { ok, message }。
 * （命令契约仍是 CommandResult；Ink 选择器需要知道是否保留行。）
 */
export function sessionActionResult(result: CommandResult): {
  ok: boolean;
  message: string;
} {
  const message = (result.output ?? '').trim();
  const ok = /^(Deleted|Renamed) session /.test(message);
  return { ok, message };
}

/** deprecated 提示文本（测试用） */
export const SESSIONS_DEPRECATION = DEPRECATION;
