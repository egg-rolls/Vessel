/**
 * File-based Session Backend 实现
 *
 * 将 Run 状态保存为 JSON 文件，每会话一个文件。
 * 0.5：同会话写入串行 + temp/rename 原子写 + session_id 路径编码。
 *
 * @module @vessel-agent/core/session
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

/** 会话文件存在但不可读/不是合法 JSON（0.8.1 损坏检测） */
export class SessionCorruptError extends Error {
  readonly code = 'session_corrupt' as const;
  readonly path: string;

  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`session_corrupt: ${path}${detail}`, { cause });
    this.name = 'SessionCorruptError';
    this.path = path;
  }
}

/** Node errno 是否为「文件不存在」；其余读取错误一律视为损坏 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 单个文件的读取结果；ENOENT 之外的可读/解析错误直接抛 SessionCorruptError */
type ReadStateResult = { found: true; state: RunState } | { found: false };

/** 归属 tenant：缺失记 default；非对象 JSON 不读取字段 */
function ownerOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'default';
  const tenantId = (value as { tenant_id?: unknown }).tenant_id;
  return tenantId === undefined || tenantId === null ? 'default' : String(tenantId);
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
   *
   * 损坏检测（0.8.1）：
   * - 主路径 `ENOENT` → 才尝试 legacy 路径；
   * - 文件存在但读取失败/JSON 解析失败 → 抛 `SessionCorruptError`，
   *   **不得**当成「无会话」回退，否则下一次 save 会静默覆盖原文件；
   * - 主路径存在但属于其它 tenant → 返回 null，不回退 legacy。
   *
   * @param sessionId 会话 ID
   * @returns Run 状态或 null（两处文件都不存在，或属于其它 tenant）
   * @throws {SessionCorruptError} 文件存在但不可读或 JSON 不合法
   */
  async load(sessionId: string): Promise<RunState | null> {
    const primaryPath = this.filePath(sessionId);
    const primary = await this.readStateFile(primaryPath);
    if (primary.found) {
      return this.isForeign(primary.state) ? null : primary.state;
    }

    const legacyPath = this.legacyFilePath(sessionId);
    if (legacyPath === undefined || legacyPath === primaryPath) return null;

    const legacy = await this.readStateFile(legacyPath);
    if (!legacy.found) return null;
    return this.isForeign(legacy.state) ? null : legacy.state;
  }

  /** 读取并解析单个状态文件；ENOENT 以外一律视为损坏 */
  private async readStateFile(path: string): Promise<ReadStateResult> {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { found: false };
      throw new SessionCorruptError(path, error);
    }

    try {
      return { found: true, state: JSON.parse(content) as RunState };
    } catch (error) {
      throw new SessionCorruptError(path, error);
    }
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
    await this.assertWritableOwner(sessionId);

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
   * 写前校验磁盘归属：primary 存在时只认它；primary 缺失才查 legacy
   * （否则新建 primary 会永久遮蔽他人 legacy 会话）。
   * 损坏文件由 readStateFile 抛 SessionCorruptError，不覆盖。
   */
  private async assertWritableOwner(sessionId: string): Promise<void> {
    if (this.tenantId === undefined) return;

    const primaryPath = this.filePath(sessionId);
    const primary = await this.readStateFile(primaryPath);
    if (primary.found) {
      if (this.isForeign(primary.state)) {
        throw new Error(
          `tenant_mismatch: session ${sessionId} belongs to ${ownerOf(primary.state)}`,
        );
      }
      return;
    }

    const legacyPath = this.legacyFilePath(sessionId);
    if (legacyPath === undefined || legacyPath === primaryPath) return;

    const legacy = await this.readStateFile(legacyPath);
    if (legacy.found && this.isForeign(legacy.state)) {
      throw new Error(`tenant_mismatch: session ${sessionId} belongs to ${ownerOf(legacy.state)}`);
    }
  }

  /**
   * 删除会话
   *
   * tenant 模式先 `load()` 校验归属：缺失或 foreign 均直接 no-op，
   * 避免通过显式 storagePath 共享目录跨 tenant 删除（0.6.1 P0-1）。
   *
   * 0.8.1：`load()` 对损坏文件抛 `SessionCorruptError`，此处不捕获——
   * 既不静默保留，也不静默删除归属未知的文件。
   * @param sessionId 会话 ID
   * @throws {SessionCorruptError} 文件存在但不可读或 JSON 不合法
   */
  async delete(sessionId: string): Promise<void> {
    const previous = this.pendingWrites.get(sessionId);
    if (previous) await previous;

    // 先校验存在性与归属；损坏文件在此抛错，绝不 unlink。
    const state = await this.load(sessionId);
    if (!state) return;

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
   *
   * 0.8.1：列表降级——单个文件损坏（`SessionCorruptError`）只跳过该项，
   * 不让整张列表失败；直接 `load()` 仍抛错，保证损坏文件不被覆盖。
   */
  async listRich(): Promise<SessionInfo[]> {
    const ids = await this.list();
    const results: SessionInfo[] = [];

    for (const id of ids) {
      let state: RunState | null;
      try {
        state = await this.load(id);
      } catch (error) {
        if (error instanceof SessionCorruptError) continue;
        throw error;
      }
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
