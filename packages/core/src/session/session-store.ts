/**
 * SessionStore 实现
 * @module @vessel-agent/core/session
 */

import type { Message } from '../types/provider.js';
import type {
  SessionInfo,
  SessionState,
  SessionStore,
  SessionTitleSource,
} from '../types/session.js';

/**
 * 从首轮用户消息派生 title/preview（照搬 Hermes list_sessions_rich 的 preview 语义）。
 *
 * 取「首轮最后一条 user」而不是第一条：RunOptions.messages 的注入消息（文件/技能内容）
 * 排在真实用户输入之前，第一条 user 往往是 `@file` 的包装内容（C-07）。
 */
export function deriveSessionMeta(messages: Message[]): { title: string; preview: string } {
  const firstAssistant = messages.findIndex((m) => m.role === 'assistant');
  const firstTurn = firstAssistant === -1 ? messages : messages.slice(0, firstAssistant);
  const turnUsers = firstTurn.filter((m) => m.role === 'user');
  const userMessage = turnUsers[turnUsers.length - 1] ?? messages.find((m) => m.role === 'user');
  const raw = (userMessage?.content ?? '').toString().replace(/\s+/g, ' ').trim();
  return {
    title: truncateCodePoints(raw, 40) || 'Untitled',
    preview: truncateCodePoints(raw, 60),
  };
}

/** 按码点截断，避免 UTF-16 `slice` 切开 emoji 的代理对。 */
function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= limit ? value : codePoints.slice(0, limit).join('');
}

/**
 * title_source 是封闭联合：JSON / SQL 上的其它值一律当「无标记」丢弃（不抛错）。
 *
 * 唯一实现：file / sqlite 两个后端与 `toSessionInfo` 共用，避免同一口径各写一份。
 */
export function normalizeTitleSource(value: unknown): SessionTitleSource | undefined {
  return value === 'manual' || value === 'generated' ? value : undefined;
}

/**
 * `SessionInfo.title_source` 的唯一出口：归一化 marker，有值才挂 key。
 *
 * 为什么单独抽一个函数：SQLite `listRich()` 直接从 SQL 行拼摘要（不解析 messages），
 * 走不到 `toSessionInfo()`；两个出口共用本函数后，字段名的拼写与「无标记 = 线上形状不变」
 * 只有一份。additive：无标记时返回原对象，形状与旧版完全一致。
 */
export function withTitleSource(info: SessionInfo, raw: unknown): SessionInfo {
  const titleSource = normalizeTitleSource(raw);
  return titleSource === undefined ? info : { ...info, title_source: titleSource };
}

/** SessionState -> SessionInfo 摘要（title/preview 优先用已存储值，否则派生） */
export function toSessionInfo(state: SessionState): SessionInfo {
  const messages = state.messages ?? [];
  const derived = deriveSessionMeta(messages);
  const info: SessionInfo = {
    session_id: state.session_id,
    title: state.title ?? derived.title,
    preview: state.preview ?? derived.preview,
    status: state.status ?? 'running',
    started_at: state.created_at,
    updated_at: state.updated_at,
    message_count: messages.length,
    branch: state.created_on_branch,
  };
  return withTitleSource(info, state.title_source);
}

/**
 * 会话列表排序：`updated_at` 倒序；同值用 `session_id` 升序，避免刷新时顺序抖动。
 *
 * 单一实现：`listRich()` 与搜索等「自己组装 SessionInfo 列表」的路径共用，
 * 避免同一口径在多个文件里各写一份后悄悄分叉。
 */
export function compareSessionInfo(a: SessionInfo, b: SessionInfo): number {
  if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
  return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
}

/**
 * 内存 SessionStore 实现
 * 用于测试和开发，生产环境应使用文件或数据库存储
 */
export class MemorySessionStore implements SessionStore {
  private sessions: Map<string, SessionState> = new Map();

  /**
   * 加载会话状态
   * @param sessionId 会话 ID
   * @returns 会话状态或 null
   */
  async load(sessionId: string): Promise<SessionState | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * 保存会话状态
   * @param state 会话状态
   */
  async save(state: SessionState): Promise<void> {
    this.sessions.set(state.session_id, { ...state });
  }

  /**
   * 删除会话
   * @param sessionId 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   * 过滤空会话，按 updated_at 倒序
   */
  async listRich(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values())
      .filter((s) => (s.messages?.length ?? 0) > 0)
      .map(toSessionInfo)
      .sort(compareSessionInfo);
  }

  /**
   * 获取会话数量
   */
  get size(): number {
    return this.sessions.size;
  }
}

export type { SessionState, SessionStore };
