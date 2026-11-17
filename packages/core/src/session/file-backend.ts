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
import { basename, dirname, join } from 'node:path';
import {
  normalizeClearedToolCallIds,
  normalizeContextAnchor,
  normalizeContextProjectionAudit,
  normalizeProjectionDeclaration,
  normalizePromptContextFingerprint,
} from '../context/index.js';
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
// 侧车文件名常量：`scanIds()` 必须跳过它，否则同一个会话会被当成两个（见那处注释）。
import { PROJECTION_CACHE_SUFFIX } from './projection-cache.js';
import {
  compareSessionInfo,
  deriveSessionMeta,
  normalizeResumeAfterRestart,
  normalizeTitleSource,
  projectionCacheKeysOf,
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

/**
 * `listRich()` 摘要侧车（`.<壳文件名>.info.json`，与壳同目录）的后缀。
 *
 * 为什么需要它：`listRich()` 只要元数据（title / preview / status / 时间戳 / 条数），
 * 而壳里 99% 的字节是 `messages` —— 进程刚起（内存缓存空）时实测 **349 个会话 / 267 MB
 * 壳 ⇒ 整份 parse ~900 ms**，而真正要看的那几个字段加起来不到 1 KiB。侧车把这份摘要
 * 摊成一个独立小文件，**唯一失效键 = 壳的 (size, mtimeMs)**：壳一变（写侧 temp+rename
 * ⇒ mtime/size 必变）侧车当场作废，退回整份 parse，并顺手把侧车补回最新。
 *
 * 命名是「**壳文件路径** + 后缀」而不是「按会话 id」：它描述的是**这一个文件**（正式路径
 * 与 legacy 未编码路径是两份文件，同一 session id 可能两个都在），也因此不必再造一份 id
 * 编码/解码口径。
 *
 * **开头必须有点**（`.<id>.json.info.json`）：老版本（0.56 及以前）的 `scanIds()` 用
 * `Bun.Glob('*.json')` 枚举会话，不认这个后缀 —— 带点则 glob 不匹配（实测
 * `Bun.Glob('*.json')` 不返回点开头的文件），于是**滚动升级期间老进程也不会把它当成
 * 一个会话**（否则列表里会多出 349 张 1970-01-01 的幽灵会话）。新代码这一侧另有
 * `scanIds()` 的后缀登记做第二道保险。
 */
const INFO_CACHE_SUFFIX = '.info.json';

/**
 * 摘要侧车的磁盘形状。
 *
 * `v` 不认识就**当没有这个文件**（回退整份 parse）：这份缓存是派生物，读不懂的版本
 * 绝不猜；`info === null` 是「这份壳没有消息」的**结论**也要一起缓存 —— 否则空会话
 * 每次都还要 parse 一遍（而它照样不进列表，输出不受影响）。
 */
interface InfoCacheFile {
  v: 1;
  /** 壳的字节数（与 `shell_mtime_ms` 一起构成唯一失效键） */
  shell_size: number;
  /** 壳的 mtime（同 `stat().mtimeMs`，含小数） */
  shell_mtime_ms: number;
  /** 那一刻 `toSessionInfo()` 的结果；`null` = 空会话（不进列表） */
  info: SessionInfo | null;
}

/** 读侧会话壳快照缓存的一条（见 `FileSessionStore#stateCache`）。 */
interface CachedState {
  /** 这份对象是从哪个路径 parse 出来的（正式路径 / legacy 路径必须分开） */
  path: string;
  /** 文件字节数（失效键的一半） */
  size: number;
  /** 文件 mtime（毫秒，失效键的另一半） */
  mtimeMs: number;
  /** 那次 parse 出来的会话壳（**共享只读**：见 `SessionStore#loadForRead` 的契约） */
  state: SessionState;
}

/** `FileSessionStore` 构造选项（additive；不传时行为与无参构造完全一致） */ export interface FileSessionStoreOptions {
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

/**
 * `listRich()` 的**有界并发**度（一次同时在途的会话数）。
 *
 * 每个会话只做两次独立的文件系统调用（stat 壳 + 读侧车），并发在这里买的是「重叠等待」，
 * 不是 CPU：8 路对一块本地盘既不抢带宽，也不会把 349 个句柄同时打开。真机 349 个会话
 * 实测串行 45–70 ms、8 路 18–28 ms（Windows/NTFS，含杀软）；再往上加没有增量收益，
 * 因为瓶颈是每次调用的固定开销而不是排队。
 */
const LIST_RICH_CONCURRENCY = 16; // startup-obs 实测：16 路把 344 壳的 sweep 从 5.0s 压到 0.86s

/**
 * 有界并发的遍历（顺序无关的场景专用）。
 *
 * 语义：`run` 至多 `limit` 个同时在途；**第一个错误按原样抛出**（其余在途任务跑完即止），
 * 与串行版「遇到错误就中断」对外等价 —— 调用方不依赖「跑了多少个」。
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        await run(item, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
  if (failure !== undefined) throw failure.error;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * 缓存覆盖水位的**读取形状**（0.54 B3）：新名字优先，旧名字当别名。
 *
 * 旧壳（只有 `derived_upto_seq`）、新壳（两个键都在）、被手改过的壳（新键是个字符串）
 * 都能读：认不出就返回空对象，绝不编一个数（与「索引坏了不编 `derived_upto_seq`」同一口径）。
 */
function projectionCacheReadOf(raw: Record<string, unknown>): {
  projection_cache_seq?: number;
  derived_upto_seq?: number;
} {
  const value = optionalNumber(raw.projection_cache_seq) ?? optionalNumber(raw.derived_upto_seq);
  if (value === undefined) return {};
  return { projection_cache_seq: value, derived_upto_seq: value };
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
    // 0.54 B3：`projection_cache_seq` 是正名，`derived_upto_seq` 是旧名（别名读）。
    // 两个都回填同一个数：旧读者（wire / migrate / 旧 core）读旧键照旧；新读者读新键。
    ...projectionCacheReadOf(raw),
    status: raw.status as SessionStatus | undefined,
    last_run_id: optionalString(raw.last_run_id) ?? optionalString(raw.run_id),
    legacy_run: toLegacyRun(raw),
    // 0.52 C：旧快照没有这个键 ⇒ undefined ⇒ 行为与 0.51 一致（裸估算）。
    context_anchor: normalizeContextAnchor(raw.context_anchor),
    // 0.52：环境快照发布指纹（旧文件没有 ⇒ undefined ⇒ 首次运行会发一张全量卡，符合预期）。
    prompt_context: normalizePromptContextFingerprint(raw.prompt_context),
    // 0.52 S1a：续跑标记（旧文件没有 ⇒ undefined ⇒ 启动不续跑任何东西）。
    resume_after_restart: normalizeResumeAfterRestart(raw.resume_after_restart),
    // 0.52 V1：本段冻结的占位集合（旧文件没有 ⇒ undefined ⇒ 请求视图不改写）。
    cleared_tool_call_ids: normalizeClearedToolCallIds(raw.cleared_tool_call_ids),
    // 0.53 U1：投射声明（旧文件没有 ⇒ undefined ⇒ resolveProjection 走 legacy ⇒ placeholder）。
    context_projection: normalizeProjectionDeclaration(raw.context_projection),
    // 0.53 U1：审计行（U2 才写；旧文件 / 脏数据 ⇒ undefined）。
    context_projection_audit: normalizeContextProjectionAudit(raw.context_projection_audit),
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
  /**
   * 本轮 `listRich()` 里排队的摘要侧车写入（自愈写回）。
   *
   * 为什么排队而不是直接 `void`：这个进程可能**说完就走**（CLI / TUI 冷启动只列一次就
   * 退出），fire-and-forget 的写会跟着进程一起消失 —— 于是每一次冷启动都重新 parse 整份壳，
   * 侧车永远建不起来。所以 `listRich()` 返回之前把它们收口（`Promise.allSettled`）：
   * 多花的是**第一次**那一趟的写盘（实测 +几十 ms），换的是此后每次冷启动 10–15 ms。
   * 失败一律吞掉（`writeInfoCache` 内部已 catch），不影响本次结果。
   */
  private infoWriteQueue: Promise<void>[] = [];
  /** 目录创建只做一次（失败后可重试） */
  private dirReady?: Promise<void>;
  /** 同一 session 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();
  /**
   * 读侧会话壳快照（{@link FileSessionStore.loadForRead}）：
   * 键 = session id，值 = (路径, size, mtimeMs, 那次 parse 出来的 `SessionState`)。
   *
   * 与上面的 `infoCache` 是同一个套路（stat 短路 + 键里带 mtime/size），只是缓存对象从
   * 「列表摘要」换成「整份 `SessionState`」。**失效条件就是键本身**：
   * 内容一变（写侧走 temp+rename 原子写 ⇒ mtime/size 必变）⇒ 键变了 ⇒ miss 重读重 parse。
   * 没有 TTL、没有手工失效、没有「写缓存」（`save()` 每写一个新壳后顺手把旧条目丢掉）。
   *
   * 为什么值里要留 `path`：`legacyFilePath`（未编码路径）与正式路径是两份文件，同一
   * session id 可能先命中 legacy 再切到正式，路径不同就绝不能复用同一份对象。
   *
   * 极端竞态与 `infoCache` 同口径：同一毫秒内两次写入且字节数完全相同 ⇒ 可能拿到上一版
   * 快照，下一次任意长度变化即修正。ext4/NTFS 的 mtimeMs 有亚毫秒精度，这个窗口需要
   * 「同长度改写 + 同 mtime 刻度」同时成立。所有需要**写**的路径都走 `load()`（读盘、
   * 独占对象），不受这里影响。
   */
  private readonly stateCache = new Map<string, CachedState>();

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

  /**
   * 会话**存在**吗？（0.56：存在性校验不再 `load()` 整份会话壳）
   *
   * 口径与 {@link load} 的 `null` 分支一致，只是**不解析**：
   * - 正式路径在 ⇒ `true`（一次 `stat`；1.8 MB 的壳 parse 一次，长寿进程实测 ~230 ms，
   *   而存在性只值一次 stat）；
   * - 正式路径 ENOENT ⇒ 看 legacy（未编码）路径，与 `load()` 同一个回退顺序；
   * - stat 报 ENOENT 以外的错（EACCES / 路径是目录 / …）⇒ **退回 `load()`**，
   *   让「不可读」继续走今天那条 `SessionCorruptError`，绝不把错误读成「不存在」。
   *
   * 已知差别（也写在 `SessionStore#exists` 的注释里）：壳在、但内容损坏时，`load()` 抛
   * `SessionCorruptError`，`exists()` 只说「在」。所以只有**不需要壳**的调用方该用它。
   */
  async exists(sessionId: string): Promise<boolean> {
    const primaryPath = this.filePath(sessionId);
    const primary = await this.statForCache(primaryPath);
    if (primary.kind === 'unknown') return (await this.load(sessionId)) !== null;
    if (primary.kind === 'present') return true;

    const legacyPath = this.legacyFilePath(sessionId);
    if (legacyPath === undefined || legacyPath === primaryPath) return false;
    const legacy = await this.statForCache(legacyPath);
    if (legacy.kind === 'unknown') return (await this.load(sessionId)) !== null;
    return legacy.kind === 'present';
  }

  /**
   * 读一侧的会话壳快照：同一份文件（path + size + mtime 都没变）只 parse 一次。
   *
   * 返回的**字段与形状与 {@link load} 逐字段相同**（同一个 `toSessionState`、同一条
   * legacy 回退、同样的 `SessionCorruptError`），唯一区别是它可能是**共享对象**：
   * 调用方不得写它（见 `SessionStore#loadForRead` 的契约）。为了「误写当场炸而不是
   * 悄悄污染缓存」，这里把壳对象与 `messages` 数组都冻上 —— 要写就用 `load()`。
   *
   * 不缓存的情形：正式路径不在（legacy / 缺失 / 未知错误）—— 那时只读一次就够快，
   * 而且 legacy → 正式路径的切换不该被缓存粘住。
   */
  async loadForRead(sessionId: string): Promise<SessionState | null> {
    const primaryPath = this.filePath(sessionId);
    const stamp = await this.statForCache(primaryPath);
    if (stamp.kind !== 'present') return this.load(sessionId);

    const hit = this.stateCache.get(sessionId);
    if (
      hit !== undefined &&
      hit.path === primaryPath &&
      hit.size === stamp.size &&
      hit.mtimeMs === stamp.mtimeMs
    ) {
      return hit.state;
    }

    const state = await this.load(sessionId);
    if (state === null) return null;
    // 只有「这份对象确实来自正式路径」才缓存：`load()` 可能回退到 legacy，
    // 那时缓存会把 legacy 的内容挂在正式路径的键上（路径不同就该各算各的）。
    const after = await this.statForCache(primaryPath);
    if (after.kind === 'present') return this.cacheState(sessionId, primaryPath, after, state);
    return state;
  }

  /** 冻结并写入快照缓存（LRU 上限与 `listRich` 同一个旋钮）。 */
  private cacheState(
    sessionId: string,
    path: string,
    stamp: { size: number; mtimeMs: number },
    state: SessionState,
  ): SessionState {
    // 冻结**同一个对象**（不换形状：`messages` 缺省就仍然是缺省，与 `load()` 逐字段一致）。
    // 冻的是壳对象与数组本身 —— 误写当场抛，而不是悄悄把缓存改成一份没人存过的状态。
    if (state.messages !== undefined) Object.freeze(state.messages);
    const frozen = Object.freeze(state);
    if (this.listRichCacheLimit > 0) {
      this.stateCache.delete(sessionId);
      this.stateCache.set(sessionId, {
        path,
        size: stamp.size,
        mtimeMs: stamp.mtimeMs,
        state: frozen,
      });
      while (this.stateCache.size > this.listRichCacheLimit) {
        const oldest = this.stateCache.keys().next();
        if (oldest.done === true) break;
        this.stateCache.delete(oldest.value);
      }
    }
    return frozen;
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

  /** 摘要侧车的路径：壳路径 + `.info.json`（与壳同目录、同前缀，删会话时一起删） */
  private infoPathOf(shellPath: string): string {
    return join(dirname(shellPath), `.${basename(shellPath)}${INFO_CACHE_SUFFIX}`);
  }

  /**
   * 读侧车：戳对不上 / 文件不在 / 形状不认 ⇒ `undefined`（= 没命中，回退整份 parse）。
   *
   * **绝不抛**：侧车是派生物，坏了、没权限、被截断都只意味着「这一条慢一点」，不许让
   * 一次列表读取失败。里面的 `JSON.parse` 走全局实现，不经过 `parseJson` 注入点 ——
   * 那个注入点是「这一次到底 parse 了几份**壳**」的量尺，侧车不是壳。
   */
  private async readInfoCache(
    shellPath: string,
    stamp: { size: number; mtimeMs: number },
  ): Promise<SessionInfo | null | undefined> {
    let text: string;
    try {
      text = await readFile(this.infoPathOf(shellPath), 'utf8');
    } catch {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
    if (typeof raw !== 'object' || raw === null) return undefined;
    const cache = raw as Partial<InfoCacheFile>;
    if (cache.v !== 1) return undefined;
    if (cache.shell_size !== stamp.size || cache.shell_mtime_ms !== stamp.mtimeMs) return undefined;
    if (cache.info === null) return null;
    const info = cache.info;
    if (typeof info !== 'object' || info === null) return undefined;
    // 只认「一份摘要」该有的形状：缺字段的当脏数据（宁可多 parse 一次，也不许编一条假会话）。
    if (
      typeof info.session_id !== 'string' ||
      typeof info.updated_at !== 'number' ||
      typeof info.message_count !== 'number'
    ) {
      return undefined;
    }
    return info;
  }

  /**
   * 落侧车（best-effort）：写失败只当「下次还得 parse 一遍」，**绝不影响本次结果**。
   *
   * `durable: false`：派生数据不值得一次 fsync —— 丢了就是退化回整份 parse，没有正确性。
   */
  private async writeInfoCache(
    shellPath: string,
    stamp: { size: number; mtimeMs: number },
    info: SessionInfo | null,
  ): Promise<void> {
    const payload: InfoCacheFile = {
      v: 1,
      shell_size: stamp.size,
      shell_mtime_ms: stamp.mtimeMs,
      info,
    };
    try {
      await atomicWrite(this.infoPathOf(shellPath), JSON.stringify(payload), { durable: false });
    } catch {
      // 侧车是派生数据：写不进去就让它下次再算一遍。
    }
  }

  /**
   * 单个状态文件 → `listRich()` 需要的摘要（三档，命中即返回）。
   *
   * 1. **内存缓存**（同一进程内同一份文件只算一次，键含 size + mtime）；
   * 2. **摘要侧车**（跨进程：进程刚起时也只读一个小文件 + 一次 `stat`，不碰 254 MB 的壳）；
   * 3. 都没有 ⇒ `readFile + JSON.parse(整份文件)`，算完把侧车补上（自愈，无需迁移）。
   *
   * 返回值：
   * - `SessionInfo`：会话非空，进列表；
   * - `null`：文件在 stat 之后消失，或会话没有消息（空会话不进列表）；
   * - 损坏：抛 `SessionCorruptError`（与 `load()` 同一口径，调用方按单文件跳过处理；
   *   异常路径**不写缓存**，坏文件不会污染缓存）。
   *
   * 三档**输出逐字节相同**：侧车存的就是 `toSessionInfo()` 的返回值，而它只在
   * (size, mtime) 与壳对得上时才作数。
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

    const sidecar = await this.readInfoCache(path, stamp);
    if (sidecar !== undefined) {
      if (sidecar === null) return null;
      this.infoCacheSet(key, sidecar);
      return { ...sidecar };
    }

    const state = await this.readStateFile(path);
    if (!state.found) return null;
    const empty = (state.state.messages?.length ?? 0) === 0;
    const info = empty ? null : toSessionInfo(state.state);

    // 读与 stat 之间文件可能被原子写替换：这份内容不能挂在旧键下（否则下一次
    // 同一 (path,size,mtime) 会命中内容不一致的条目）。戳不一致就放弃缓存这一条。
    const confirm = await this.statForCache(path);
    if (
      confirm.kind === 'present' &&
      confirm.size === stamp.size &&
      confirm.mtimeMs === stamp.mtimeMs
    ) {
      if (info !== null) this.infoCacheSet(key, info);
      // 自愈：这次 parse 是白读的，把结论记下来，下一次冷启动就不必再读整份壳。
      // **排队**（不是 `void`）：`listRich()` 结束前会统一收口，否则「列一次就退出」的
      // 进程会让这些写跟着进程一起消失（见 `infoWriteQueue`）。
      this.infoWriteQueue.push(
        this.writeInfoCache(path, { size: stamp.size, mtimeMs: stamp.mtimeMs }, info),
      );
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
    // 写侧永远不读缓存；写完顺手丢掉旧快照（键里本来就有 mtime/size，这里只是省一次
    // 「同长度同 mtime 刻度」的竞态窗口）。
    this.stateCache.delete(sessionId);

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
      // 0.54 B3：缓存覆盖水位写两个键（正名 + 旧名同值）。旧键保留 = 旧读者不降级。
      ...projectionCacheKeysOf(state),
      // 0.52 C：真实用量锚点。旧文件没有这个键 ⇒ 读取时为 undefined ⇒ 裸估算（0.51 行为）。
      ...(state.context_anchor !== undefined ? { context_anchor: state.context_anchor } : {}),
      ...(state.prompt_context !== undefined ? { prompt_context: state.prompt_context } : {}),
      // 0.52 S1a：续跑标记。同样只在有值时写，旧文件形状不变。
      ...(state.resume_after_restart !== undefined
        ? { resume_after_restart: state.resume_after_restart }
        : {}),
      // 0.52 V1：本段冻结的占位集合。同样只在有值时写。
      ...(state.cleared_tool_call_ids !== undefined
        ? { cleared_tool_call_ids: state.cleared_tool_call_ids }
        : {}),
      // 0.53 U1：会话级投射声明 + 审计行（ADR-104 §5.1）。同样只在有值时写，
      // 旧文件形状不变；旧文件读回来是 undefined ⇒ 走 legacy 解析（placeholder）。
      ...(state.context_projection !== undefined
        ? { context_projection: state.context_projection }
        : {}),
      ...(state.context_projection_audit !== undefined && state.context_projection_audit !== null
        ? { context_projection_audit: state.context_projection_audit }
        : {}),
    };

    await atomicWrite(this.filePath(sessionId), JSON.stringify(disk, null, 2));
    // 0.57：写了壳**不动摘要侧车**。它按 (size, mtime) 自校验 ⇒ 这一份侧车当场作废，
    // 下一次列表读会重算并补回最新（读侧自愈），不需要写侧多付一次 stat + 写盘。
    //
    // 量过：写侧顺带刷新（stat 壳 + 写侧车）让一次保存 3.7–5.3 ms → 12.4–12.7 ms
    // （400 条消息的会话，20/40 轮中位数），而它省下的只是**别的进程**下一次冷启动对
    // 这一份壳的一次整份 parse（~1–15 ms，且只对「刚写过的那几个会话」）。2–3 倍的写
    // 代价换一次性的读收益，不划算 —— 热路径（每次 run 都要保存）尤其不划算。
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
    this.stateCache.delete(sessionId);

    // 先校验存在性与归属；损坏文件在此抛错，绝不 unlink。
    const state = await this.load(sessionId);
    if (!state) return;

    const candidates = [this.filePath(sessionId), this.legacyFilePath(sessionId)];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      // 壳与它的摘要侧车一起删：侧车只描述壳，壳没了它就是垃圾文件
      // （`scanIds()` 虽然会跳过它，但留着会让目录越长越乱）。
      for (const path of [candidate, this.infoPathOf(candidate)]) {
        try {
          await unlink(path);
        } catch {
          // 文件不存在则静默忽略
        }
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
        // 会话目录里同时存在 `<id>.json`（会话壳）、`<id>.projection.json`（投影游标快照，
        // 0.56 引入）与 `.<id>.json.info.json`（`listRich()` 摘要侧车，0.57 引入；带点 ⇒
        // 这个 glob 本来就不返回它，下面那行是第二道保险）。
        // `*.json` 会把它们也当成一个会话 ⇒ 同一个会话在列表里出现两次：
        // 一张有真实 updated_at、另一张变成 1970-01-01（因为它是侧车、没有时间字段）。
        // 以后再加任何 `<id>.<kind>.json` 侧车文件，都要登记到这里。
        if (f.endsWith(PROJECTION_CACHE_SUFFIX)) continue;
        if (f.endsWith(INFO_CACHE_SUFFIX)) continue;
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
    // 保序槽位：`forEachBounded` 按输入顺序传 index，完成后统一收集（不随完成顺序漂移）。
    const slots: Array<SessionInfo | null> = new Array(ids.length).fill(null);

    // 0.57：**有界并发**（不是多线程）。每个会话是「stat + 读侧车」两次独立的文件系统
    // 调用，串行 349 次就等于 349 个来回排在一行里（真机 ~45–70 ms）；16 路并发只是把
    // 等待重叠起来，不增加任何工作、不改变任何一条结果 —— 顺序由下面那次全序 sort
    // （`updated_at` 倒序 + `session_id` 升序）决定，与完成的先后无关。
    //
    // 结果必须**按输入顺序**收（`forEachBounded` 保序），这样「第一个错误」不会随
    // 完成顺序漂移；单个文件损坏（`SessionCorruptError`）只跳过该项（0.8.1 口径）。
    await forEachBounded(ids, LIST_RICH_CONCURRENCY, async (id, index) => {
      try {
        const info = await this.listRichInfo(id);
        if (info !== null) slots[index] = info;
      } catch (error) {
        if (!(error instanceof SessionCorruptError)) throw error;
      }
    });
    for (const info of slots) if (info !== null) results.push(info);

    // updated_at 倒序；同值用 session_id 升序，避免刷新时顺序抖动。
    results.sort(compareSessionInfo);
    // 收口本轮的自愈写回（见 `infoWriteQueue`）：让「列过一次就退出」的进程也把侧车落下。
    if (this.infoWriteQueue.length > 0) {
      const pending = this.infoWriteQueue;
      this.infoWriteQueue = [];
      await Promise.allSettled(pending);
    }
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
