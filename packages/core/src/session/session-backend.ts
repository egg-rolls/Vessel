/**
 * Session Backend 实现
 * @module @vessel/core/session
 */

import type { RunState, SessionBackend } from '../types/session.js';

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
  async load(session_id: string): Promise<RunState | null> {
    return this.sessions.get(session_id) ?? null;
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
  async delete(session_id: string): Promise<void> {
    this.sessions.delete(session_id);
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
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

  constructor(basePath: string = './sessions') {
    this.basePath = basePath;
  }

  /**
   * 加载 Run 状态
   * @param session_id 会话 ID
   * @returns Run 状态或 null
   */
  async load(session_id: string): Promise<RunState | null> {
    try {
      const filePath = `${this.basePath}/${session_id}.json`;
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
  async delete(session_id: string): Promise<void> {
    const filePath = `${this.basePath}/${session_id}.json`;
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
      const files = await Array.fromAsync(
        new Bun.Glob('*.json').scan(this.basePath)
      );
      return files.map((f: string) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }
}

export type { RunState, SessionBackend };
