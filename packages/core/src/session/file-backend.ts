/**
 * File-based SessionStore 实现
 *
 * 将会话壳（SessionState）保存为 JSON 文件，每会话一个文件。
 * 0.5：同会话写入串行 + temp/rename 原子写 + session_id 路径编码。
 *
 * 磁盘格式沿用旧键（`started_at` / `branch` / `run_id` / `completed_at` ...
 * 作为镜像），新旧 reader 都能解析；读取时映射回 `SessionState`。
 *
 * @module @vessel-agent/core/session
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../types/provider.js';
import type { RunUsage } from '../types/run-record-store.js';
import type {
  LegacyRunSnapshot,
  SessionInfo,
  SessionState,
  SessionStatus,
  SessionStore,
} from '../types/session.js';
import { atomicWrite } from './atomic-write.js';
import { deriveSessionMeta, toSessionInfo } from './session-store.js';

/**
 * 文件 SessionStore 实现
 *
 * 存储格式：`{basePath}/{encodeURIComponent(session_id)}.json`
 * 旧数据（未编码文件名）在 load 时回退读取。
 */
export interface FileSessionStoreOptions {
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
type ReadStateResult = { found: true; state: SessionState } | { found: false };

/** 归属 tenant：缺失记 default；非对象 JSON 不读取字段 */
function ownerOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'default';
  const tenantId = (value as { tenant_id?: unknown }).tenant_id;
  return tenantId === undefined || tenantId === null ? 'default' : String(tenantId);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** 旧 JSON 顶层 run 字段 -> SessionState.legacy_run（一版兼容） */
function toLegacyRun(raw: Record<string, unknown>): LegacyRunSnapshot | undefined {
  const completed_at = optionalNumber(raw.completed_at);
  const usage =
    typeof raw.usage === 'object' && raw.usage !== null ? (raw.usage as RunUsage) : undefined;
  const error = optionalString(raw.error);
  if (completed_at === undefined && usage === undefined && error === undefined) return undefined;
  return {
    ...(completed_at !== undefined ? { completed_at } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * 磁盘 JSON -> SessionState。
 *
 * 旧键 `started_at` / `branch` / `run_id` / `completed_at` / `usage` / `error`
 * 分别映射到 `created_at` / `created_on_branch` / `last_run_id` / `legacy_run`；
 * 不做形状校验（与旧实现一致），`messages` 非数组时降级为 undefined。
 */
function toSessionState(value: unknown): SessionState {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const createdAt = optionalNumber(raw.created_at) ?? optionalNumber(raw.started_at) ?? 0;
  const updatedAt = optionalNumber(raw.updated_at) ?? createdAt;
  return {
    session_id: raw.session_id as string,
    created_at: createdAt,
    updated_at: updatedAt,
    title: optionalString(raw.title),
    preview: optionalString(raw.preview),
    tenant_id: optionalString(raw.tenant_id),
    created_on_branch: optionalString(raw.created_on_branch) ?? optionalString(raw.branch),
    messages: Array.isArray(raw.messages) ? (raw.messages as Message[]) : undefined,
    derived_upto_seq: optionalNumber(raw.derived_upto_seq),
    status: raw.status as SessionStatus | undefined,
    last_run_id: optionalString(raw.last_run_id) ?? optionalString(raw.run_id),
    legacy_run: toLegacyRun(raw),
  };
}

export class FileSessionStore implements SessionStore {
  private readonly basePath: string;
  private readonly tenantId?: string;
  /** 目录创建只做一次（失败后可重试） */
  private dirReady?: Promise<void>;
  /** 同一 session 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  /**
   * @param basePath 会话文件存储目录，默认 `.vessel/sessions`
   */
  constructor(basePath = '.vessel/sessions', options: FileSessionStoreOptions = {}) {
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
   * 加载会话状态
   *
   * 损坏检测（0.8.1）：
   * - 主路径 `ENOENT` → 才尝试 legacy 路径；
   * - 文件存在但读取失败/JSON 解析失败 → 抛 `SessionCorruptError`，
   *   **不得**当成「无会话」回退，否则下一次 save 会静默覆盖原文件；
   * - 主路径存在但属于其它 tenant → 返回 null，不回退 legacy。
   *
   * @param sessionId 会话 ID
   * @returns 会话状态或 null（两处文件都不存在，或属于其它 tenant）
   * @throws {SessionCorruptError} 文件存在但不可读或 JSON 不合法
   */
  async load(sessionId: string): Promise<SessionState | null> {
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
      return { found: true, state: toSessionState(JSON.parse(content)) };
    } catch (error) {
      throw new SessionCorruptError(path, error);
    }
  }

  /**
   * 保存会话状态
   *
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at，
   * 行为与 SQLiteSessionStore 一致。同 session 串行写入。
   * 磁盘保留旧顶层 run 字段镜像（status/run_id/completed_at/usage/error/branch），
   * 供旧 reader 解析。
   *
   * @param state 会话状态
   */
  async save(state: SessionState): Promise<void> {
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

  private async writeSession(sessionId: string, state: SessionState): Promise<void> {
    await this.ensureDir();

    const effective = this.applyTenant(state);
    await this.assertWritableOwner(sessionId);

    const messages = effective.messages ?? [];
    const meta = deriveSessionMeta(messages);
    const title = effective.title ?? meta.title;
    const preview = effective.preview ?? meta.preview;
    const updatedAt = effective.updated_at ?? Date.now();

    const disk = {
      session_id: effective.session_id,
      title,
      preview,
      tenant_id: effective.tenant_id,
      created_at: effective.created_at,
      updated_at: updatedAt,
      started_at: effective.created_at,
      completed_at: effective.legacy_run?.completed_at,
      status: effective.status,
      usage: effective.legacy_run?.usage,
      error: effective.legacy_run?.error,
      branch: effective.created_on_branch,
      run_id: effective.last_run_id,
      messages,
      derived_upto_seq: effective.derived_upto_seq,
    };

    await atomicWrite(this.filePath(sessionId), JSON.stringify(disk, null, 2));
  }

  /** 写入前补齐/校验 tenant_id；跨 tenant 直接抛错 */
  private applyTenant(state: SessionState): SessionState {
    if (this.tenantId === undefined) return state;
    if (state.tenant_id !== undefined && state.tenant_id !== this.tenantId) {
      throw new Error(`tenant_mismatch: session ${state.session_id} belongs to ${state.tenant_id}`);
    }
    return state.tenant_id === this.tenantId ? state : { ...state, tenant_id: this.tenantId };
  }

  /** 读取时过滤其它 tenant 的会话（缺省视为 default） */
  private isForeign(state: SessionState): boolean {
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

  /** 扫描目录内的会话 id（不做 tenant 过滤；list / listRich 共用） */
  private async scanIds(): Promise<string[]> {
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
   * 列出所有会话 ID
   *
   * tenant 模式下逐 id `load()`：只返回本 tenant 的会话，损坏项跳过
   * （与 listRich 的降级一致），其它错误上抛。非 tenant 原样返回。
   * @returns 会话 ID 数组（去后缀 .json 并解码）
   */
  async list(): Promise<string[]> {
    const ids = await this.scanIds();
    if (this.tenantId === undefined) return ids;

    const visible: string[] = [];
    for (const id of ids) {
      try {
        if ((await this.load(id)) !== null) visible.push(id);
      } catch (error) {
        if (error instanceof SessionCorruptError) continue;
        throw error;
      }
    }
    return visible;
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
    const ids = await this.scanIds();
    const results: SessionInfo[] = [];

    for (const id of ids) {
      let state: SessionState | null;
      try {
        state = await this.load(id);
      } catch (error) {
        if (error instanceof SessionCorruptError) continue;
        throw error;
      }
      if (state && (state.messages?.length ?? 0) > 0) {
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

export type { SessionState, SessionStore };
