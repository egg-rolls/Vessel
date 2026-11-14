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

import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeContextAnchor, normalizePromptContextFingerprint } from '../context/index.js';
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
import {
  compareSessionInfo,
  deriveSessionMeta,
  normalizeTitleSource,
  toSessionInfo,
} from './session-store.js';

/**
 * 文件 SessionStore 实现
 *
 * 存储格式：`{basePath}/{encodeURIComponent(session_id)}.json`
 * 旧数据（未编码文件名）在 load 时回退读取。
 */

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

/**
 * `listRich()` 摘要缓存用的文件戳。
 * - `present`：缓存键的原料（size + mtimeMs）；
 * - `missing`：ENOENT（回退 legacy 路径 / 没有会话）；
 * - `unknown`：其它 stat 错误（权限等）—— 不猜，交给原读取路径按「损坏」口径处理。
 */
type FileStamp =
  | { kind: 'present'; size: number; mtimeMs: number }
  | { kind: 'missing' }
  | { kind: 'unknown' };

/**
 * `listRich()` 摘要缓存上限（LRU）。
 * 512 条 `SessionInfo`（全是原始类型，单条 < 1 KiB）≈ 常数级内存，覆盖真实租户的
 * 二三十个会话几十倍；超出后按「最久未使用」淘汰，缓存大小与目录里文件数无关。
 * 会话数**超过**上限时最坏退化：按目录顺序循环扫描 + LRU 必然互相踢掉，每轮都 miss
 * —— 等价于没有缓存（不会比改造前更差，只是白记一份）。
 */
const LIST_RICH_CACHE_LIMIT = 512;

/** `FileSessionStore` 构造选项（additive；不传时行为与无参构造完全一致） */
export interface FileSessionStoreOptions {
  /**
   * `listRich()` 摘要缓存条数上限（LRU，缺省 {@link LIST_RICH_CACHE_LIMIT}）；0 = 关闭缓存。
   *
   * 只影响加速，不改变数据来源：条目按 `(path, size, mtimeMs)` 校验，文件一变就重新解析。
   */
  listRichCacheLimit?: number;
  /**
   * `JSON.parse` 的注入点（缺省全局 `JSON.parse`）。**只给门禁 / 测试用**：
   * `scripts/check-listrich-cache.ts` 用它数「这一趟到底 parse 了几个文件」。
   */
  parseJson?: (text: string) => unknown;
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
    // 封闭联合：磁盘上的其它值一律当「无标记」丢弃（与 sqlite / toSessionInfo 同一口径）。
    title_source: normalizeTitleSource(raw.title_source),
    preview: optionalString(raw.preview),
    created_on_branch: optionalString(raw.created_on_branch) ?? optionalString(raw.branch),
    messages: Array.isArray(raw.messages) ? (raw.messages as Message[]) : undefined,
    derived_upto_seq: optionalNumber(raw.derived_upto_seq),
    status: raw.status as SessionStatus | undefined,
    last_run_id: optionalString(raw.last_run_id) ?? optionalString(raw.run_id),
    legacy_run: toLegacyRun(raw),
    // 0.52 C：旧快照没有这个键 ⇒ undefined ⇒ 行为与 0.51 一致（裸估算）。
    context_anchor: normalizeContextAnchor(raw.context_anchor),
    // 0.52：环境快照发布指纹（旧文件没有 ⇒ undefined ⇒ 首次运行会发一张全量卡，符合预期）。
    prompt_context: normalizePromptContextFingerprint(raw.prompt_context),
  };
}

export class FileSessionStore implements SessionStore {
  private readonly basePath: string;
  private readonly parseJson: (text: string) => unknown;
  private readonly listRichCacheLimit: number;
  /**
   * `listRich()` 摘要缓存：键 = `path\0mtimeMs\0size`，值 = 该文件当时的 `SessionInfo`。
   *
   * 失效条件就是键本身（mtime + size）：内容变了 ⇒ 键变了 ⇒ miss 重解析，旧条目
   * 自然被 LRU 挤掉。**语义零变化**——缓存只是省掉 `readFile + JSON.parse(整份
   * 10MB)`，同一份文件内容仍然映射到同一份 `SessionInfo`；`load()` / `save()` /
   * `delete()` 都不读也不写它（写侧走 temp+rename 原子写，mtime/size 必变）。
   *
   * 极端竞态：同一毫秒内两次写入且字节数完全相同（mtimeMs 与 size 都没变）时，
   * 这一次扫描可能拿到上一版摘要 —— 后果是「列表里一条会话的 title/updated_at
   * 晚一个轮询周期」，下一次 ws 推送或任意一次内容长度变化即修正；不涉及读侧
   * 正确性（`load()` 永远读盘）。ext4/NTFS 的 mtimeMs 有亚毫秒精度，这个窗口
   * 需要「同长度改写 + 同 mtime 刻度」同时成立，比缓存省下的 parse 便宜得多。
   */
  private readonly infoCache = new Map<string, SessionInfo>();
  /** 目录创建只做一次（失败后可重试） */
  private dirReady?: Promise<void>;
  /** 同一 session 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  /**
   * @param basePath 会话文件存储目录，默认 `.vessel/sessions`
   */
  constructor(basePath = '.vessel/sessions', options: FileSessionStoreOptions = {}) {
    this.basePath = basePath;
    this.parseJson = options.parseJson ?? ((text: string) => JSON.parse(text) as unknown);
    const limit = options.listRichCacheLimit ?? LIST_RICH_CACHE_LIMIT;
    this.listRichCacheLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
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
    if (primary.found) return primary.state;

    const legacyPath = this.legacyFilePath(sessionId);
    if (legacyPath === undefined || legacyPath === primaryPath) return null;

    const legacy = await this.readStateFile(legacyPath);
    if (!legacy.found) return null;
    return legacy.state;
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
      return { found: true, state: toSessionState(this.parseJson(content)) };
    } catch (error) {
      throw new SessionCorruptError(path, error);
    }
  }

  /** `stat` 一个候选状态文件；ENOENT → missing，其它错误 → unknown（不覆盖原损坏口径） */
  private async statForCache(path: string): Promise<FileStamp> {
    try {
      const info = await stat(path);
      return { kind: 'present', size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' };
      return { kind: 'unknown' };
    }
  }

  /** LRU 读：命中即移到队尾（Map 的迭代顺序 = 插入顺序）并返回新浅拷贝 */
  private infoCacheGet(key: string): SessionInfo | undefined {
    const hit = this.infoCache.get(key);
    if (hit === undefined) return undefined;
    this.infoCache.delete(key);
    this.infoCache.set(key, hit);
    return hit;
  }

  /** LRU 写：超出上限时从队首淘汰最久未使用的条目 */
  private infoCacheSet(key: string, info: SessionInfo): void {
    if (this.listRichCacheLimit <= 0) return;
    this.infoCache.delete(key);
    this.infoCache.set(key, info);
    while (this.infoCache.size > this.listRichCacheLimit) {
      const oldest = this.infoCache.keys().next();
      if (oldest.done === true) return;
      this.infoCache.delete(oldest.value);
    }
  }

  /**
   * 单个状态文件 → `listRich()` 需要的摘要（带缓存）。
   *
   * 命中只花一次 `stat`；未命中才 `readFile + JSON.parse(整份文件)`。返回值：
   * - `SessionInfo`：会话非空，进列表；
   * - `null`：文件在 stat 之后消失，或会话没有消息（空会话不进列表，**不缓存**——
   *   空文件很小，缓存收益不值得为它放宽「值 = SessionInfo」的口径）；
   * - 损坏：抛 `SessionCorruptError`（与 `load()` 同一口径，调用方按单文件跳过处理；
   *   异常路径**不写缓存**，坏文件不会污染缓存）。
   */
  private async infoForPath(
    path: string,
    stamp: { size: number; mtimeMs: number },
  ): Promise<SessionInfo | null> {
    const key = `${path}\u0000${stamp.mtimeMs}\u0000${stamp.size}`;
    const cached = this.infoCacheGet(key);
    // 给调用方新鲜对象（旧实现每次都是新解析出来的对象），调用方改字段也污染不到缓存。
    // `SessionInfo` 全是原始类型，浅拷贝即完整拷贝。
    if (cached !== undefined) return { ...cached };

    const state = await this.readStateFile(path);
    if (!state.found) return null;
    if ((state.state.messages?.length ?? 0) === 0) return null;
    const info = toSessionInfo(state.state);

    // 读与 stat 之间文件可能被原子写替换：这份内容不能挂在旧键下（否则下一次
    // 同一 (path,size,mtime) 会命中内容不一致的条目）。戳不一致就放弃缓存这一条。
    const confirm = await this.statForCache(path);
    if (
      confirm.kind === 'present' &&
      confirm.size === stamp.size &&
      confirm.mtimeMs === stamp.mtimeMs
    ) {
      this.infoCacheSet(key, info);
    }
    return info;
  }

  /** 无缓存路径（stat 报 unknown / 刚被替换）：与改造前的 `load()` 同一口径 */
  private async infoWithoutCache(path: string): Promise<SessionInfo | null> {
    const state = await this.readStateFile(path);
    if (!state.found) return null;
    return (state.state.messages?.length ?? 0) > 0 ? toSessionInfo(state.state) : null;
  }

  /**
   * 单个会话的 `listRich()` 摘要（主路径 → legacy 顺序与 `load()` 一致）。
   * 只有 `stat` 成功才可能走缓存；stat 报其它错误时退回原读取口径（损坏照旧抛）。
   */
  private async listRichInfo(sessionId: string): Promise<SessionInfo | null> {
    const primaryPath = this.filePath(sessionId);
    const primary = await this.statForCache(primaryPath);
    if (primary.kind === 'present') return this.infoForPath(primaryPath, primary);
    if (primary.kind === 'unknown') return this.infoWithoutCache(primaryPath);

    // 主路径 ENOENT 才回退 legacy（与 `load()` 同一顺序；主路径损坏不回退）。
    const legacyPath = this.legacyFilePath(sessionId);
    if (legacyPath === undefined || legacyPath === primaryPath) return null;
    const legacy = await this.statForCache(legacyPath);
    if (legacy.kind === 'present') return this.infoForPath(legacyPath, legacy);
    if (legacy.kind === 'unknown') return this.infoWithoutCache(legacyPath);
    return null;
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

    const messages = state.messages ?? [];
    const meta = deriveSessionMeta(messages);
    const title = state.title ?? meta.title;
    const preview = state.preview ?? meta.preview;
    const updatedAt = state.updated_at ?? Date.now();

    const disk = {
      session_id: state.session_id,
      title,
      // Additive: only written when set, so old readers / old files stay untouched.
      ...(state.title_source !== undefined ? { title_source: state.title_source } : {}),
      preview,
      created_at: state.created_at,
      updated_at: updatedAt,
      started_at: state.created_at,
      completed_at: state.legacy_run?.completed_at,
      status: state.status,
      usage: state.legacy_run?.usage,
      error: state.legacy_run?.error,
      branch: state.created_on_branch,
      run_id: state.last_run_id,
      messages,
      derived_upto_seq: state.derived_upto_seq,
      // 0.52 C：真实用量锚点。旧文件没有这个键 ⇒ 读取时为 undefined ⇒ 裸估算（0.51 行为）。
      ...(state.context_anchor !== undefined ? { context_anchor: state.context_anchor } : {}),
      ...(state.prompt_context !== undefined ? { prompt_context: state.prompt_context } : {}),
    };

    await atomicWrite(this.filePath(sessionId), JSON.stringify(disk, null, 2));
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
   * @returns 会话 ID 数组（去后缀 .json 并解码）
   */
  async list(): Promise<string[]> {
    return this.scanIds();
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   *
   * 过滤空会话（message_count > 0），按 updated_at 倒序。
   *
   * **有界缓存（LRU 512，键 = `path + mtimeMs + size`）**：每次仍 `stat` 一遍目录里
   * 的文件，但文件没变（size 与 mtimeMs 都相同）就直接返回上次的摘要，不再
   * `readFile + JSON.parse` 整份 JSON。审计实测 32 会话 / 10.1MB 时 `listRich()`
   * **33.5ms/次**（全部花在解析），命中后只剩 32 次 `stat`（亚毫秒），而
   * `sessions.list` 是 15s 轮询、TUI / liveness sweep / resume 也各自调它 —— 缓存
   * 命中的是「稳态下反复问同一批没变的文件」。语义不变：同一份文件内容 ⇒ 同一份
   * `SessionInfo`；写侧是 temp+rename 原子写，内容一变 mtime/size 必变（极端
   * 「同长度 + 同 mtime 刻度」的竞态见 `infoCache` 注释）。
   *
   * 0.8.1：列表降级——单个文件损坏（`SessionCorruptError`）只跳过该项，
   * 不让整张列表失败；直接 `load()` 仍抛错，保证损坏文件不被覆盖。
   */
  async listRich(): Promise<SessionInfo[]> {
    const ids = await this.scanIds();
    const results: SessionInfo[] = [];

    for (const id of ids) {
      try {
        const info = await this.listRichInfo(id);
        if (info !== null) results.push(info);
      } catch (error) {
        if (error instanceof SessionCorruptError) continue;
        throw error;
      }
    }

    // updated_at 倒序；同值用 session_id 升序，避免刷新时顺序抖动。
    results.sort(compareSessionInfo);
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
