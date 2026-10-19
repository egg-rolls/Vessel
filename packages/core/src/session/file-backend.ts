/**
 * File-based Session Backend 实现
 *
 * 将 Run 状态保存为 JSON 文件，每会话一个文件。
 * 0.5：同会话写入串行 + temp/rename 原子写 + session_id 路径编码。
 *
 * @module @vessel/core/session
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState, SessionBackend, SessionInfo } from '../types/session.js';
import { atomicWrite } from './atomic-write.js';
import { deriveSessionMeta, toSessionInfo } from './session-backend.js';

/**
 * 文件 Session Backend 实现
 *
 * 存储格式：`{basePath}/{encodeURIComponent(session_id)}.json`
 * 旧数据（未编码文件名）在 load 时回退读取。
 */
export interface FileSessionBackendOptions {
  /** 配置后：写入补齐 tenant_id，读取过滤其它 tenant 的会话 */
  tenantId?: string;
}

export class FileSessionBackend implements SessionBackend {
  private readonly basePath: string;
  private readonly tenantId?: string;
  /** 目录创建只做一次（失败后可重试） */
  private dirReady?: Promise<void>;
  /** 同一 session 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  /**
   * @param basePath 会话文件存储目录，默认 `.vessel/sessions`
   */
  constructor(basePath = '.vessel/sessions', options: FileSessionBackendOptions = {}) {
    this.basePath = basePath;
    this.tenantId = options.tenantId;
  }

  /**
   * 确保存储目录存在（惰性创建，首次读写时触发）
   */
  private async ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.basePath, { recursive: true })
      .then(() => {})
      .catch((error: unknown) => {
        this.dirReady = undefined;
        throw error;
      });
    return this.dirReady;
  }

  /** 校验 session id（空值/非法编码抛错） */
  private assertSessionId(sessionId: string): string {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('invalid_session_id: session_id must be a non-empty string');
    }
    try {
      encodeURIComponent(sessionId);
    } catch {
      throw new Error('invalid_session_id: session_id contains invalid characters');
    }
    return sessionId;
  }

  /** 编码后的正式路径 */
  private filePath(sessionId: string): string {
    const id = this.assertSessionId(sessionId);
    return join(this.basePath, `${encodeURIComponent(id)}.json`);
  }

  /** 旧版未编码路径（仅对无路径分隔符的 id 生效） */
  private legacyFilePath(sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    if (sessionId === '.' || sessionId === '..') return undefined;
    if (sessionId.includes('/') || sessionId.includes('\\')) return undefined;
    return join(this.basePath, `${sessionId}.json`);
  }

  /**
   * 加载 Run 状态
   * @param sessionId 会话 ID
   * @returns Run 状态或 null（文件不存在或解析失败）
   */
  async load(sessionId: string): Promise<RunState | null> {
    const candidates = [this.filePath(sessionId), this.legacyFilePath(sessionId)];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      try {
        const content = await readFile(candidate, 'utf8');
        const parsed = JSON.parse(content) as RunState;
        return this.isForeign(parsed) ? null : parsed;
      } catch {
        // 尝试下一个候选路径
      }
    }
    return null;
  }

  /**
   * 保存 Run 状态
   *
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at，
   * 行为与 SQLiteSessionBackend 一致。同 session 串行写入。
   *
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    const sessionId = state.session_id;
    const previous = this.pendingWrites.get(sessionId) ?? Promise.resolve();
    const task = () => this.writeSession(sessionId, state);
    const current = previous.then(task, task);
    const tail = current.then(
      () => {},
      () => {},
    );
    this.pendingWrites.set(sessionId, tail);

    try {
      await current;
    } finally {
      if (this.pendingWrites.get(sessionId) === tail) this.pendingWrites.delete(sessionId);
    }
  }

  private async writeSession(sessionId: string, state: RunState): Promise<void> {
    await this.ensureDir();

    const effective = this.applyTenant(state);
    const meta = deriveSessionMeta(effective.messages);
    const title = effective.title ?? meta.title;
    const preview = effective.preview ?? meta.preview;
    const updatedAt = effective.updated_at ?? Date.now();

    const enriched: RunState = {
      ...effective,
      title,
      preview,
      updated_at: updatedAt,
    };

    await atomicWrite(this.filePath(sessionId), JSON.stringify(enriched, null, 2));
  }

  /** 写入前补齐/校验 tenant_id；跨 tenant 直接抛错 */
  private applyTenant(state: RunState): RunState {
    if (this.tenantId === undefined) return state;
    if (state.tenant_id !== undefined && state.tenant_id !== this.tenantId) {
      throw new Error(`tenant_mismatch: session ${state.session_id} belongs to ${state.tenant_id}`);
    }
    return state.tenant_id === this.tenantId ? state : { ...state, tenant_id: this.tenantId };
  }

  /** 读取时过滤其它 tenant 的会话（缺省视为 default） */
  private isForeign(state: RunState): boolean {
    if (this.tenantId === undefined) return false;
    if (typeof state !== 'object' || state === null) return true;
    return (state.tenant_id ?? 'default') !== this.tenantId;
  }

  /**
   * 删除会话
   * @param sessionId 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    const previous = this.pendingWrites.get(sessionId);
    if (previous) await previous;

    const candidates = [this.filePath(sessionId), this.legacyFilePath(sessionId)];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      try {
        await unlink(candidate);
      } catch {
        // 文件不存在则静默忽略
      }
    }
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组（去后缀 .json 并解码）
   */
  async list(): Promise<string[]> {
    await this.ensureDir();

    try {
      const glob = new Bun.Glob('*.json');
      const ids: string[] = [];
      for await (const f of glob.scan(this.basePath)) {
        if (f.startsWith('.')) continue;
        const raw = f.replace(/\.json$/, '');
        try {
          ids.push(decodeURIComponent(raw));
        } catch {
          ids.push(raw);
        }
      }
      return ids;
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

    // updated_at 倒序；同值用 session_id 升序，避免刷新时顺序抖动。
    results.sort((a, b) => {
      if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
      return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
    });
    return results;
  }

  /**
   * 关闭（文件后端无持久连接，空操作）
   */
  close(): void {
    // no-op: file backend has no persistent connection
  }
}

export type { RunState, SessionBackend };
