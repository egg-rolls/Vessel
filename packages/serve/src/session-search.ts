/**
 * 会话内容搜索（0.6.1 E5）。
 *
 * 数据面只依赖 core 的 `SessionStore`：`list()` 拿 id，一次 `load()` 同时得到
 * 摘要与 messages 并线性扫描内容（file/sqlite 后端通用）。
 * 结果形状冻结为 `{ sessions: SessionSearchHit[] }` 的元素。
 *
 * @module @vessel-agent/serve/session-search
 */

import {
  compareSessionInfo,
  type Message,
  SessionCorruptError,
  type SessionInfo,
  type SessionState,
  type SessionStore,
  toSessionInfo,
} from '@vessel-agent/core';

/** 默认/最大返回条数（E5 冻结形状的 limit 上限） */
export const DEFAULT_SESSION_SEARCH_LIMIT = 20;
export const MAX_SESSION_SEARCH_LIMIT = 100;

/** 单条 snippet 的命中前后窗口（字符） */
const SNIPPET_RADIUS = 60;

/** 搜索结果元素（DECISION-015 E5 冻结形状） */
export interface SessionSearchHit {
  session_id: string;
  title: string;
  preview: string;
  snippet: string;
  updated_at: number;
  message_count: number;
}

/** 校验 query：去空白后 1..256 字符；非法返回 null。 */
export function normalizeSearchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const query = raw.trim();
  if (query.length === 0 || query.length > 256) return null;
  return query;
}

/** 校验 limit：缺省 20；必须是 1..100 的整数；非法返回 null。 */
export function parseSearchLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_SESSION_SEARCH_LIMIT;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_SESSION_SEARCH_LIMIT) return null;
  return raw;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 取首个命中的窗口；`needle` 必须已小写。 */
export function makeSnippet(content: string, needle: string): string {
  const collapsed = collapseWhitespace(content);
  const index = collapsed.toLowerCase().indexOf(needle);
  if (index < 0) return collapsed.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, index + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`;
}

/**
 * 在单个会话中查找 query；返回 snippet，未命中返回 null。
 * 匹配顺序：title / preview / session_id，然后是消息 content。
 */
export function findSessionSnippet(
  session: Pick<SessionInfo, 'session_id' | 'title' | 'preview'>,
  messages: readonly Message[],
  query: string,
): string | null {
  const needle = query.toLowerCase();
  for (const field of [session.title, session.preview, session.session_id]) {
    if (typeof field === 'string' && field.toLowerCase().includes(needle)) {
      return collapseWhitespace(session.preview || session.title || session.session_id).slice(
        0,
        SNIPPET_RADIUS * 2,
      );
    }
  }
  for (const message of messages) {
    if (typeof message.content === 'string' && message.content.toLowerCase().includes(needle)) {
      return makeSnippet(message.content, needle);
    }
  }
  return null;
}

/**
 * 线性扫描一个 tenant 的会话后端。
 *
 * 0.52：**一遍 parse**。以前是 `listRich()`（整文件 parse 一次、只留摘要）
 * 再对每个会话 `load()`（第二遍 parse），同一份磁盘字节算两次；现在
 * `list()` + 一次 `load()`，从同一份 state 同时产出 `SessionInfo` 与 messages。
 * 口径与 `listRich()` 一致：跳过空会话、按 `updated_at` 倒序（共用 core 的比较器）。
 *
 * `limit` 只裁输出：仍需扫完才有完整排序，但不再重复 parse。
 */
export async function searchSessions(
  backend: SessionStore,
  query: string,
  limit: number = DEFAULT_SESSION_SEARCH_LIMIT,
): Promise<SessionSearchHit[]> {
  const ids = await backend.list();
  const rows: Array<{ info: SessionInfo; messages: readonly Message[] }> = [];
  for (const sessionId of ids) {
    let state: SessionState | null;
    try {
      state = await backend.load(sessionId);
    } catch (error) {
      // 与 `listRich()` 同口径：单个损坏会话只跳过该项，其余错误照常上抛。
      if (error instanceof SessionCorruptError) continue;
      throw error;
    }
    if (state === null) continue;
    const messages = state.messages ?? [];
    if (messages.length === 0) continue;
    rows.push({ info: toSessionInfo(state), messages });
  }
  rows.sort((a, b) => compareSessionInfo(a.info, b.info));

  const hits: SessionSearchHit[] = [];
  for (const { info, messages } of rows) {
    if (hits.length >= limit) break;
    const snippet = findSessionSnippet(info, messages, query);
    if (snippet === null) continue;
    hits.push({
      session_id: info.session_id,
      title: info.title,
      preview: info.preview,
      snippet,
      updated_at: info.updated_at,
      message_count: info.message_count,
    });
  }
  return hits;
}
