/**
 * File-based Session Backend 实现
 *
 * 将 Run 状态保存为 JSON 文件，每会话一个文件。
 * 最轻量的持久化方案——零原生依赖，纯 JSON 读写。
 *
 * @module @vessel/core/session
 */

import { mkdirSync } from 'node:fs';
import type { RunState, SessionBackend, SessionInfo } from '../types/session.js';
import { deriveSessionMeta, toSessionInfo } from './session-backend.js';

/**
 * 文件 Session Backend 实现
 *
 * 存储格式：`{basePath}/{session_id}.json`
 * 适用于不需要数据库依赖的单机部署场景。
 */
export class FileSessionBackend implements SessionBackend {
  private basePath: string;

  /**
   * @param basePath 会话文件存储目录，默认 `.vessel/sessions`
   */
  constructor(basePath = '.vessel/sessions') {
    this.basePath = basePath;
  }

  /**
   * 确保存储目录存在（惰性创建，首次读写时触发）
   */
  private ensureDir(): void {
    try {
      mkdirSync(this.basePath, { recursive: true });
    } catch {
      // Directory may already exist — that's fine
    }
  }

  /**
   * 获取会话文件路径
   */
  private filePath(sessionId: string): string {
    return `${this.basePath}/${sessionId}.json`;
  }

  /**
   * 加载 Run 状态
   * @param sessionId 会话 ID
   * @returns Run 状态或 null（文件不存在或解析失败）
   */
  async load(sessionId: string): Promise<RunState | null> {
    try {
      const content = await Bun.file(this.filePath(sessionId)).text();
      return JSON.parse(content) as RunState;
    } catch {
      return null;
    }
  }

  /**
   * 保存 Run 状态
   *
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at，
   * 行为与 SQLiteSessionBackend 一致。
   *
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    this.ensureDir();

    const meta = deriveSessionMeta(state.messages);
    const title = state.title ?? meta.title;
    const preview = state.preview ?? meta.preview;
    const updatedAt = state.updated_at ?? Date.now();

    const enriched: RunState = {
      ...state,
      title,
      preview,
      updated_at: updatedAt,
    };

    await Bun.write(this.filePath(state.session_id), JSON.stringify(enriched, null, 2));
  }

  /**
   * 删除会话
   * @param sessionId 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    try {
      await Bun.file(this.filePath(sessionId)).delete();
    } catch {
      // 文件不存在则静默忽略
    }
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组（去后缀 .json）
   */
  async list(): Promise<string[]> {
    this.ensureDir();

    try {
      const glob = new Bun.Glob('*.json');
      const files: string[] = [];
      for await (const f of glob.scan(this.basePath)) {
        files.push(f.replace(/\.json$/, ''));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   *
   * 过滤空会话（message_count > 0），按 updated_at 倒序。
   * 每个文件独立加载——文件数量通常很小（几十到几百），无需批量优化。
   */
  async listRich(): Promise<SessionInfo[]> {
    const ids = await this.list();
    const results: SessionInfo[] = [];

    for (const id of ids) {
      const state = await this.load(id);
      if (state && state.messages.length > 0) {
        results.push(toSessionInfo(state));
      }
    }

    results.sort((a, b) => b.updated_at - a.updated_at);
    return results;
  }

  /**
   * 关闭（文件后端无持久连接，空操作）
   */
  close(): void {
    // no-op: file backend has no persistent connection
  }
}
