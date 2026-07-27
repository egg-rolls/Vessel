/**
 * Session Backend 实现
 * @module @vessel/core/session
 */

import type { Message } from '../types/provider.js';
import type { RunState, SessionBackend, SessionInfo } from '../types/session.js';

/** 从首条用户消息派生 title/preview（照搬 Hermes list_sessions_rich 的 preview 语义） */
export function deriveSessionMeta(messages: Message[]): { title: string; preview: string } {
  const firstUser = messages.find((m) => m.role === 'user');
  const raw = (firstUser?.content ?? '').toString().replace(/\s+/g, ' ').trim();
  return {
    title: raw.slice(0, 40) || 'Untitled',
    preview: raw.slice(0, 60),
  };
}

/** RunState -> SessionInfo 摘要（title/preview 优先用已存储值，否则派生） */
export function toSessionInfo(state: RunState): SessionInfo {
  const derived = deriveSessionMeta(state.messages);
  return {
    session_id: state.session_id,
    title: state.title ?? derived.title,
    preview: state.preview ?? derived.preview,
    status: state.status,
    started_at: state.started_at,
    updated_at: state.updated_at ?? state.completed_at ?? state.started_at,
    message_count: state.messages.length,
  };
}

/**
 * 内存 Session Backend 实现
 * 用于测试和开发，生产环境应使用文件或数据库存储
 */
export class MemorySessionBackend implements SessionBackend {
  private sessions: Map<string, RunState> = new Map();

  /**
   * 加载 Run 状态
   * @param session_id 会话 ID
   * @returns Run 状态或 null
   */
  async load(sessionId: string): Promise<RunState | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * 保存 Run 状态
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    this.sessions.set(state.session_id, { ...state });
  }

  /**
   * 删除会话
   * @param session_id 会话 ID
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
      .filter((s) => s.messages.length > 0)
      .map(toSessionInfo)
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  /**
   * 获取会话数量
   */
  get size(): number {
    return this.sessions.size;
  }
}

/**
 * 文件 Session Backend 实现
 * 将 Run 状态保存到文件系统
 */
export class FileSessionBackend implements SessionBackend {
  private basePath: string;

  constructor(basePath = './sessions') {
    this.basePath = basePath;
  }

  /**
   * 加载 Run 状态
   * @param session_id 会话 ID
   * @returns Run 状态或 null
   */
  async load(sessionId: string): Promise<RunState | null> {
    try {
      const filePath = `${this.basePath}/${sessionId}.json`;
      const content = await Bun.file(filePath).text();
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * 保存 Run 状态
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    const filePath = `${this.basePath}/${state.session_id}.json`;
    await Bun.write(filePath, JSON.stringify(state, null, 2));
  }

  /**
   * 删除会话
   * @param session_id 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    const filePath = `${this.basePath}/${sessionId}.json`;
    try {
      await Bun.file(filePath).delete();
    } catch {
      // 文件不存在则忽略
    }
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    try {
      const files = await Array.fromAsync(new Bun.Glob('*.json').scan(this.basePath));
      return files.map((f: string) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   * 过滤空会话，按 updated_at 倒序
   */
  async listRich(): Promise<SessionInfo[]> {
    const ids = await this.list();
    const states: RunState[] = [];
    for (const id of ids) {
      const s = await this.load(id);
      if (s) states.push(s);
    }
    return states
      .filter((s) => s.messages.length > 0)
      .map(toSessionInfo)
      .sort((a, b) => b.updated_at - a.updated_at);
  }
}

export type { RunState, SessionBackend };
