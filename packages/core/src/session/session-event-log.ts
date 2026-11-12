/**
 * 会话事件日志（0.18，唯一真相源）。
 *
 * 布局（additive，不改旧 session 文件）：
 *   <sessions_dir>/<encodeURIComponent(session_id)>/
 *     events.ndjson   追加写、0600、每条 fsync（批量路径 `appendMany` 是整批一次）
 *     index.json      元数据（title/preview/status/timestamps/event_count/derived_upto_seq）
 *
 * 单条记录 v1：`{v:1, session_id, run_id, seq, ts, type, data}`。
 * `seq` 按 **session** 单调；启动时从文件尾部恢复，写入时在同一 session 的
 * 串行队列里分配，保证 append 顺序 = seq 顺序。
 *
 * 崩溃恢复：文件尾部若残留半行（无换行结尾），初始化为 append 前先截断到
 * 最后一个完整换行，避免新记录粘在半行后面。
 *
 * 单写者与轮换：
 * - 同一进程内按 session 串行；
 * - 跨进程必须由上层 tenant / session 写锁串行化（本类不做进程间互斥）；
 * - 为防轮换写者复用 seq，每次 append 前 `stat` 文件：大小与上次写后不一致时
 *   重读文件尾并把 `assignedSeq` 单调抬到实际最后 seq；文件被删除则抛
 *   `session_event_log_deleted`，不静默写进已删除的 inode；
 * - 无锁并发写不受支持（stat 检查不能消除同时写入的竞争）。
 *
 * @module @vessel-agent/core/session
 */

import { createReadStream, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, mkdir, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { noopLogger } from '../logging.js';
// D2：跨模块只允许从 barrel 导入（不得直接引用 tenant 的内部文件）。
import {
  encodeSessionDirName,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
} from '../tenant/index.js';
import type { SessionEventInput, SessionEventRecord, SessionIndexPatch } from '../types/event.js';
import { LeaseExpiredError, type LeaseKind } from '../types/lease.js';
import type { Logger } from '../types/logging.js';
import { atomicWrite } from './atomic-write.js';

/** 会话索引（`index.json`）；只放元数据，messages 仍是缓存 */
export interface SessionLogIndex {
  v: 1;
  session_id: string;
  title?: string;
  preview?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  started_at?: number;
  updated_at: number;
  /** 已落盘事件数（= 最后 seq；seq 从 1 连续递增） */
  event_count: number;
  /** 元数据派生覆盖到的 seq；与 event_count 同步 */
  derived_upto_seq: number;
  /** 显式标注：`sessions/<id>.json` 中的 messages 只是投影缓存 */
  messages_cached: true;
}

/** 读取选项；`sinceSeq` 为**排他**游标（只返回 seq > sinceSeq） */
export interface ReadSessionEventsOptions {
  sinceSeq?: number;
  limit?: number;
}

/** 构造选项 */
export interface SessionEventLogOptions {
  /** tenant 的 sessions 目录（`<tenant>/sessions`） */
  dir: string;
  tenantId?: string;
  logger?: Logger;
  /** 每条 fsync；缺省 true（测试可关） */
  durable?: boolean;
  /**
   * ADR-098 C2：可选 fencing 校验（装配层传 `LeaseServicePort.fenceOf`）。
   * `SessionEventInput.fencing_token` 低于当前 fence 时拒绝 append（`stale_fence`）。
   * 缺省不校验；读路径永远不校验。
   */
  fenceOf?: (kind: LeaseKind, key: string) => Promise<number>;
  /**
   * 同时保持打开的写句柄上限（LRU）。超过时关闭最久未使用的 writer；
   * 下次 append 会重新打开并从文件尾恢复 seq。缺省 32。
   */
  maxOpenWriters?: number;
}

/** 尾部恢复时读取的最大窗口序列（先小后大，最后扫全文件） */
const TAIL_WINDOW_BYTES = 64 * 1024;
const TAIL_WINDOW_MAX = 4 * 1024 * 1024;
/** 同时保持打开的 writer 上限 */
const DEFAULT_MAX_OPEN_WRITERS = 32;
/**
 * `readTailMatches` 的尾窗回扫口径：首窗 64 KiB，不够就 ×4 扩窗，
 * 最多读 {@link TAIL_MATCH_MAX_BYTES} 后放弃（**不回退全量扫盘**）。
 */
const TAIL_MATCH_FIRST_BYTES = 64 * 1024;
const TAIL_MATCH_MAX_BYTES = 4 * 1024 * 1024;

interface WriterState {
  sessionId: string;
  /** 初始化（mkdir/恢复 seq/打开文件）完成 */
  ready: Promise<void>;
  /** 串行写入链（永不 reject） */
  queue: Promise<void>;
  /** 最后分配的 seq（可能尚未落盘） */
  assignedSeq: number;
  /** 最后成功落盘的 seq */
  persistedSeq: number;
  /** 已落盘事件数（与 persistedSeq 同步；seq 连续） */
  persistedCount: number;
  /** 上次写成功后预期的文件字节数；用于发现其它写者/删除 */
  expectedSize: number;
  /** 最近一次使用时间（LRU 关闭） */
  lastUsed: number;
  handle?: FileHandle;
  closed: boolean;
}

/** 事件日志写入目标已被删除（不静默重建） */
export class SessionEventLogDeletedError extends Error {
  readonly code = 'session_event_log_deleted' as const;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session_event_log_deleted: ${sessionId}`);
    this.name = 'SessionEventLogDeletedError';
    this.sessionId = sessionId;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 宽松结构校验：坏行（含崩溃残留半行）直接跳过 */
function parseRecord(line: string): SessionEventRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) return null;
    if (typeof parsed.run_id !== 'string') return null;
    if (typeof parsed.type !== 'string' || parsed.type.length === 0) return null;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
    if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)) return null;
    return {
      v: 1,
      session_id: parsed.session_id,
      run_id: parsed.run_id,
      seq: Math.floor(parsed.seq),
      ts: parsed.ts,
      type: parsed.type,
      data: parsed.data,
      ...(typeof parsed.fencing_token === 'number' && Number.isFinite(parsed.fencing_token)
        ? { fencing_token: parsed.fencing_token }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 从文件尾部恢复最后一个有效 seq；无法解析时返回 0 */
async function recoverLastSeq(path: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  let window = Math.min(TAIL_WINDOW_BYTES, size);
  for (;;) {
    const start = Math.max(0, size - window);
    const length = size - start;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const record = parseRecord(lines[index] ?? '');
        if (record) return Math.max(0, record.seq);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    if (start === 0) return 0;
    // 超过最大窗口仍未找到完整记录：最后一次读全文件（极端大单条记录）。
    window = window >= TAIL_WINDOW_MAX ? size : Math.min(window * 8, size);
  }
}

/** 若文件末尾不是换行，截断到最后一个完整行（返回截断后大小） */
async function truncatePartialTail(path: string, size: number): Promise<number> {
  if (size <= 0) return size;
  const handle = await open(path, 'r+');
  try {
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    for (;;) {
      const start = size - window;
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, start);
      // 最后一字节是换行：整个文件已完整
      if (start + window === size && buffer[window - 1] === 0x0a) return size;
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const truncateTo = start + lastNewline + 1;
        await handle.truncate(truncateTo);
        return truncateTo;
      }
      // 单条记录可能超过窗口：扩大到整个文件
      if (start === 0) {
        await handle.truncate(0);
        return 0;
      }
      window = Math.min(window * 8, size);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 尾窗定位结果：`empty` = `since` 之后没有记录；`offset` = `since` 之后第一条记录的起始字节。
 */
type IncrementalStart = { kind: 'empty' } | { kind: 'offset'; offset: number };

/**
 * 把 `[offset, offset+length)` 读满（单次 read 不保证读满）。
 * 读不满说明文件在读取期间变短了：返回 `undefined`，让调用方回退全量读，不猜。
 */
async function readWindow(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 从文件尾部回溯，定位「`seq > since` 的第一条记录」的字节偏移。
 *
 * 会话日志只追加（唯一写点是 append 模式的 `write`，truncate 只截崩溃残行），
 * 所以文件尾部一定以 seq 递增的顺序收尾：读一个尾窗就能定边界，不必把整份
 * NDJSON 从头流一遍（实测 44MB 日志：全量 202ms，增量读 164ms 却只返回 20 行）。
 *
 * 保守校验 —— 任一条不满足就返回 `undefined`，由调用方回退全量流读：
 * - 只按**本 session** 的行判定：混进来的别的 session 记录 seq 属另一个序列，
 *   跳过即可（读路径本来就会按 `session_id` 过滤）。
 * - 本 session 能解析的行必须逐条 `seq = 下一条 - 1`。模块头已说明「轮换写者下
 *   行序不保证与 seq 一致」；这类场景**只保证不返回错数据**，不承诺也能变快。
 * - 边界行的 seq 必须正好等于 `since`（seq 连续），否则不猜。
 * - 单条记录超过窗口上限（`TAIL_WINDOW_MAX`）时不猜。
 *
 * 判定**只认磁盘**，不读 writer 的内存游标：否则「别的进程刚追加了一条」会被
 * 误判成「没有新事件」。
 */
async function findIncrementalStart(
  path: string,
  size: number,
  sessionId: string,
  since: number,
): Promise<IncrementalStart | undefined> {
  let window = Math.min(TAIL_WINDOW_BYTES, size);
  for (;;) {
    const start = Math.max(0, size - window);
    let buffer: Buffer | undefined;
    try {
      buffer = await readWindow(path, start, size - start);
    } catch (error) {
      if (isNotFound(error)) return { kind: 'empty' };
      throw error;
    }
    // 文件在读取期间被截短（残行截断/删除）：不猜，回退全量读。
    if (buffer === undefined) return undefined;

    // 从窗口末尾往前逐行解析。
    let cursor = buffer.length; // 当前行在 buffer 内的结束位置（不含换行）
    let expected: number | undefined; // 已确认位于边界之后的最近一条 seq
    let sawOwn = false; // 是否已经解析到过本 session 的记录
    let decided: IncrementalStart | undefined;
    while (cursor > 0) {
      let stop = cursor;
      while (stop > 0 && buffer[stop - 1] === 0x0a) stop -= 1; // 跳过行尾换行
      if (stop === 0) break;
      const newline = buffer.lastIndexOf(0x0a, stop - 1);
      if (newline === -1 && start > 0) {
        // 窗口起点切在一条记录中间：不拼接，扩窗重来。
        break;
      }
      const lineStart = newline + 1; // 0 = 这一行从窗口起点开始
      const record = parseRecord(buffer.toString('utf8', lineStart, stop));
      cursor = lineStart;
      if (record === null) {
        // 文件尾的崩溃残行（无换行结尾）解析不出记录：跳过它继续往前找，
        // 与 `recoverLastSeq` 同一策略；出现在中间则不再猜。
        if (!sawOwn) continue;
        return undefined;
      }
      // 别的 session 的记录不参与判定（seq 是 per-session 的，混进来会假不连续）。
      if (record.session_id !== sessionId) continue;
      sawOwn = true;
      if (expected !== undefined && record.seq !== expected - 1) return undefined;
      if (record.seq <= since) {
        // 这一行就是边界；它之后的记录都 > since（上面已逐条校验连续性）。
        decided =
          record.seq === since ? { kind: 'offset', offset: start + stop + 1 } : { kind: 'empty' };
        break;
      }
      expected = record.seq;
    }
    if (decided !== undefined) return decided;
    if (start === 0) return undefined; // 整份文件都看过了仍无结论：交给全量读
    if (window >= TAIL_WINDOW_MAX) return undefined; // 单条记录超过窗口上限
    window = Math.min(window * 8, size);
  }
}

/** `readTailMatches` 的结果：命中记录（**新 → 旧**）+ 本次从磁盘读了多少字节。 */
export interface TailMatches {
  /** 命中的记录，按文件顺序**从新到旧**（日志只追加 ⇒ 也等于 seq 降序）。 */
  records: SessionEventRecord[];
  /** 本次调用实际读的字节数（缓存 / 读取成本说明用） */
  bytesRead: number;
}

/** `readTailMatches` 选项。 */
export interface ReadTailMatchesOptions {
  /** 最多取几条命中（缺省 8）；命中够了就不再往前扫。 */
  limit?: number;
  /** 回扫字节预算（缺省 4 MiB；下限 1 字节、不会超过文件大小）。 */
  maxBytes?: number;
}

/**
 * 在一个尾窗内**从后往前**收集 `type ∈ types` 的本 session 记录（新 → 旧）。
 *
 * 只解析完整行：窗口起点切在一条记录中间时（`completeFromStart === false`），
 * 那一行（buffer 偏移 0 起的部分）不完整，直接丢弃 —— 不拼接、不猜。
 * 坏行 / 崩溃残行跳过（与 `recoverLastSeq` 同策略）；别的 session 的记录跳过
 * （多写者 / 目录混用时 seq 属另一个序列）。
 */
function scanTailWindow(
  buffer: Buffer,
  completeFromStart: boolean,
  sessionId: string,
  types: ReadonlySet<string>,
  limit: number,
): SessionEventRecord[] {
  const found: SessionEventRecord[] = [];
  let cursor = buffer.length;
  while (cursor > 0) {
    let stop = cursor;
    while (stop > 0 && buffer[stop - 1] === 0x0a) stop -= 1; // 跳过行尾换行
    if (stop === 0) break;
    const newline = buffer.lastIndexOf(0x0a, stop - 1);
    // 窗口起点切在记录中间：buffer[0] 起的那一行不可信，到此为止（由调用方扩窗）。
    if (newline === -1 && !completeFromStart) break;
    const lineStart = newline + 1;
    const record = parseRecord(buffer.toString('utf8', lineStart, stop));
    cursor = lineStart;
    if (record === null) continue;
    if (record.session_id !== sessionId) continue;
    if (!types.has(record.type)) continue;
    found.push(record);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * 追加写会话事件日志。
 *
 * 读写均可在同一实例上并发调用：同 session 写入串行，读取先等待该 session
 * 的写入队列排空（读到已落盘的数据）。
 */
export class SessionEventLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly durable: boolean;
  private readonly fenceOf?: (kind: LeaseKind, key: string) => Promise<number>;
  private readonly maxOpenWriters: number;
  private readonly writers = new Map<string, WriterState>();
  /**
   * LRU 淘汰后的 drain 链（key = session_id）。
   * 新 writer 的 `ready` 必须排在同 session 的旧 drain 之后，否则会在旧队列
   * 尚未落盘时重读文件尾，导致重复 seq。
   */
  private readonly draining = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: SessionEventLogOptions) {
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new Error('SessionEventLog requires a non-empty dir');
    }
    this.dir = options.dir;
    this.logger = options.logger ?? noopLogger;
    this.durable = options.durable ?? true;
    this.fenceOf = options.fenceOf;
    this.maxOpenWriters = Math.max(
      1,
      Math.floor(options.maxOpenWriters ?? DEFAULT_MAX_OPEN_WRITERS),
    );
  }

  /** 会话目录是否存在（删除一致性检查/索引列表用） */
  async hasSession(sessionId: string): Promise<boolean> {
    try {
      const info = await stat(sessionDirPath(this.dir, sessionId));
      return info.isDirectory();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** 追加一条事件；顺序即调用顺序，返回已分配的 seq */
  append(input: SessionEventInput): Promise<SessionEventRecord> {
    if (this.closed) {
      return Promise.reject(new Error('session_event_log_closed'));
    }
    if (typeof input.session_id !== 'string' || input.session_id.length === 0) {
      return Promise.reject(new Error('invalid_session_id: session_id must be non-empty'));
    }

    const state = this.getOrCreateWriter(input.session_id);
    const task = state.queue.then(async () => {
      await state.ready;
      // ADR-098 C2：旧 fencing token 必须被拒（在分配 seq / 写入之前）。
      if (input.fencing_token !== undefined && this.fenceOf !== undefined) {
        const current = await this.fenceOf('session', input.session_id);
        if (input.fencing_token < current) {
          throw new LeaseExpiredError('stale_fence', input.session_id);
        }
      }
      await this.syncWithFile(state);
      state.lastUsed = Date.now();
      const seq = state.assignedSeq + 1;
      state.assignedSeq = seq;
      const record: SessionEventRecord = {
        v: 1,
        session_id: input.session_id,
        run_id: input.run_id,
        seq,
        ts: input.ts,
        type: input.type,
        data: input.data,
        ...(input.fencing_token !== undefined ? { fencing_token: input.fencing_token } : {}),
      };
      const handle = state.handle;
      if (!handle) throw new Error('session_event_log_unavailable');
      const line = `${JSON.stringify(record)}\n`;
      const written = await handle.write(line);
      // `durable:false` 只用于「一批写完再统一 fsync」的批量路径（如种子消息）：
      // 逐条 fsync 的 1.52ms 会按条数线性叠加（1814 条 ≈ 2.8s），
      // 调用方必须在返回前调一次 `sync()` 补上落盘保证。
      if (this.durable && input.durable !== false) await handle.sync();
      state.persistedSeq = seq;
      state.persistedCount += 1;
      state.expectedSize += written.bytesWritten;
      return record;
    });
    state.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /**
   * 批量追加**同一个 session** 的若干事件：**单次 write + 单次 fsync**。
   *
   * 为什么不是 `for (const e of events) await append(e)`：单条 append 的成本大头是
   * 每条的 `stat`（对齐文件尾）+ 一次 `write` + 一次 `handle.sync()`；审计实测
   * durable **1.52ms/条**、非 durable **0.58ms/条**，1814 条的种子消息光这一项就
   * 是 2.8s / 1.05s，全串行卡在 create RPC 里。本方法把整批拼成一个 buffer，
   * 只 `write` 一次、`fsync` 一次：同一批的条数与磁盘字节数无关地摊薄到 ~1ms。
   *
   * **语义与逐条 append 完全一致**（唯一改动是落盘的系统调用次数）：
   * - `seq` 仍是本 session 的单调序列，按入参顺序逐条 +1 分配 —— 同一事件序列走
   *   `append` 与走 `appendMany` 得到**同一个 seq 序列**；
   * - 每行仍是 `JSON.stringify(record) + "\n"`，拼起来的字节与逐条写**逐字节相同**；
   * - fencing 逐条校验（任一旧 token 在写之前就整批拒绝），口径同 `append`；
   * - `durable` 仍是「缺省跟随实例」：批内只要有一条没显式 `durable:false`，
   *   整批最后 fsync 一次（比逐条 fsync 弱的地方只有「写到一半崩溃」的落盘粒度，
   *   而这恰好是调用方要的：崩溃时整批要么都在、要么只剩前缀，不会出现
   *   「顺序靠后的事件已落盘、靠前的没落盘」）。
   *
   * 与磁盘的对齐（`syncWithFile`）只在**批首**做一次：整批在同一个串行队列里，
   * 同进程内没有别的写者能插进来；跨进程仍按类注释的约定由上层写锁串行化。
   *
   * @returns 与入参顺序一一对应的记录（含已分配的 seq）
   */
  appendMany(inputs: readonly SessionEventInput[]): Promise<SessionEventRecord[]> {
    if (this.closed) {
      return Promise.reject(new Error('session_event_log_closed'));
    }
    if (inputs.length === 0) return Promise.resolve([]);
    const sessionId = inputs[0]?.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('invalid_session_id: session_id must be non-empty'));
    }
    // `seq` 是 per-session 序列：一个批次只能写一个 session，否则整批拒绝（不做静默分组）。
    for (const input of inputs) {
      if (input.session_id !== sessionId) {
        return Promise.reject(
          new Error('invalid_session_id: appendMany requires a single session_id'),
        );
      }
    }

    const batch = inputs.slice();
    const state = this.getOrCreateWriter(sessionId);
    const task = state.queue.then(async () => {
      await state.ready;
      // ADR-098 C2：逐条校验 fence（在分配 seq / 写入之前整批判定）。
      if (this.fenceOf !== undefined) {
        const fenceOf = this.fenceOf;
        for (const input of batch) {
          if (input.fencing_token === undefined) continue;
          const current = await fenceOf('session', sessionId);
          if (input.fencing_token < current) {
            throw new LeaseExpiredError('stale_fence', sessionId);
          }
        }
      }
      await this.syncWithFile(state);
      state.lastUsed = Date.now();
      const handle = state.handle;
      if (!handle) throw new Error('session_event_log_unavailable');

      const records: SessionEventRecord[] = [];
      let payload = '';
      let lastSeq = state.persistedSeq;
      for (const input of batch) {
        const seq = state.assignedSeq + 1;
        state.assignedSeq = seq;
        const record: SessionEventRecord = {
          v: 1,
          session_id: input.session_id,
          run_id: input.run_id,
          seq,
          ts: input.ts,
          type: input.type,
          data: input.data,
          ...(input.fencing_token !== undefined ? { fencing_token: input.fencing_token } : {}),
        };
        records.push(record);
        payload += `${JSON.stringify(record)}\n`;
        lastSeq = seq;
      }

      const buffer = Buffer.from(payload, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('session_event_log_write_failed');
        offset += bytesWritten;
      }
      state.persistedSeq = lastSeq;
      state.persistedCount += records.length;
      state.expectedSize += buffer.length;
      // 与单条 append 同口径：只要有条目要求 durable（缺省跟随实例）就落一次盘。
      if (this.durable && batch.some((input) => input.durable !== false)) await handle.sync();
      return records;
    });
    state.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /**
   * 重新对齐文件尾（拿锁后 / 轮换写者时调用）。
   * 不等待此前入队的 append；调用方应先保证没有在途写入。
   */
  async refresh(sessionId: string): Promise<void> {
    const state = this.writers.get(sessionId);
    if (!state) return;
    await state.ready;
    await state.queue;
    await this.syncWithFile(state);
  }

  /**
   * 关闭并移除该 session 的写句柄（run 结束 / idle 回收）。
   * 下次 append 会重新打开并从文件尾恢复 seq。幂等。
   */
  async release(sessionId: string): Promise<void> {
    const state = this.writers.get(sessionId);
    if (!state) return;
    await state.queue;
    await state.ready.catch(() => {});
    try {
      await state.handle?.close();
    } catch {
      // 已关闭
    }
    state.handle = undefined;
    state.closed = true;
    this.writers.delete(sessionId);
  }

  /** 最近一次已落盘的 seq（不等待队列） */
  lastPersistedSeq(sessionId: string): number | undefined {
    const state = this.writers.get(sessionId);
    return state !== undefined && state.persistedSeq > 0 ? state.persistedSeq : undefined;
  }

  /** 从磁盘读取最后 seq（没有 writer 也能用；文件不存在/为空返回 undefined） */
  async lastSeq(sessionId: string): Promise<number | undefined> {
    const state = this.writers.get(sessionId);
    if (state) {
      await state.ready.catch(() => {});
      await state.queue;
      if (state.persistedSeq > 0) return state.persistedSeq;
    }
    await this.draining.get(sessionId)?.catch(() => {});
    const path = sessionEventsFilePath(this.dir, sessionId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (size <= 0) return undefined;
    const last = await recoverLastSeq(path, size);
    return last > 0 ? last : undefined;
  }

  /** 等待写入队列排空；sessionId 缺省等待全部 */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      const state = this.writers.get(sessionId);
      if (state) await state.queue;
      await this.draining.get(sessionId)?.catch(() => {});
      return;
    }
    await Promise.all([
      ...[...this.writers.values()].map((state) => state.queue),
      ...[...this.draining.values()].map((drain) => drain.catch(() => {})),
    ]);
  }

  /**
   * 把该 session 已入队的事件真正落到磁盘（fsync 一次）。
   *
   * 配合 `append({ durable: false })` 使用：批量写入时跳过逐条 fsync，
   * 调用方在整批（含顺序上的首条事件）都写完后调用本方法一次，即可在返回前
   * 重新获得「已落盘」保证。幂等；没有 writer 或实例本身非 durable 时为空操作。
   */
  async sync(sessionId: string): Promise<void> {
    const state = this.writers.get(sessionId);
    if (!state) {
      await this.draining.get(sessionId)?.catch(() => {});
      return;
    }
    await state.queue;
    await state.ready.catch(() => {});
    if (!this.durable) return;
    if (state.handle) {
      await state.handle.sync();
      return;
    }
    // 句柄已被回收（LRU）时补一次：现开一个句柄 fsync 后关闭。
    const handle = await open(sessionEventsFilePath(this.dir, sessionId), 'r+').catch(
      () => undefined,
    );
    if (!handle) return;
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * 读取事件（按 seq 升序）。
   *
   * 增量读（`sinceSeq`）会先从**尾部窗口**定位「`seq > sinceSeq` 的第一条记录」，
   * 只流这一小段；定位不出来时回退整份流读，返回值与全量扫一遍完全一致。
   *
   * @param opts.sinceSeq 排他游标：只返回 `seq > sinceSeq`
   * @param opts.limit 最大条数；缺省不限制
   */
  async read(
    sessionId: string,
    opts: ReadSessionEventsOptions = {},
  ): Promise<SessionEventRecord[]> {
    const state = this.writers.get(sessionId);
    if (state) {
      await state.ready.catch(() => {});
      await state.queue;
    }
    // 被 LRU 淘汰但仍在 drain 的同一 session：等它写完再读。
    await this.draining.get(sessionId)?.catch(() => {});

    const path = sessionEventsFilePath(this.dir, sessionId);
    const since = typeof opts.sinceSeq === 'number' ? Math.floor(opts.sinceSeq) : undefined;
    const limit =
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(0, Math.floor(opts.limit))
        : undefined;
    if (limit === 0) return [];

    // 增量读只流「since 之后」那一段：日志只追加（见模块头），所以尾部窗口
    // 足以定位边界；稳态（`since == 最后 seq`）连流都不开，直接返回空。
    // 定位失败（单条记录超过窗口上限 / 行序与 seq 不一致 / 混入别的 session）
    // 一律回退下面的全量流读 —— 只保证不会返回错数据，不承诺那里也快。
    let startOffset = 0;
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (since !== undefined && since > 0 && size > 0) {
      const found = await findIncrementalStart(path, size, sessionId, since);
      if (found?.kind === 'empty') return [];
      if (found?.kind === 'offset') {
        if (found.offset >= size) return [];
        startOffset = found.offset;
      }
    }

    const collected: SessionEventRecord[] = [];
    let malformed = 0;
    let foreign = 0;
    const accept = (record: SessionEventRecord | null): void => {
      if (record === null) {
        malformed += 1;
        return;
      }
      // 多写者/目录混用时文件里可能有别的 session 记录；必须按 session_id 过滤。
      if (record.session_id !== sessionId) {
        foreign += 1;
        return;
      }
      if (since !== undefined && record.seq <= since) return;
      collected.push(record);
    };
    // 流式读取：避免把大 session 的整份 NDJSON 读进内存。
    // 设置 encoding 后 Node 的 Readable 内部用 StringDecoder，跨 chunk 的多字节字符安全。
    // `start` 从尾部窗口定位到的记录边界开始（0 表示从头，与改造前一致）。
    const stream = createReadStream(
      path,
      startOffset > 0 ? { encoding: 'utf8', start: startOffset } : { encoding: 'utf8' },
    );
    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          accept(parseRecord(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      // 文件末尾没有换行的残行（崩溃残留）按坏行处理。
      if (buffer.trim() !== '') accept(parseRecord(buffer));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    } finally {
      stream.destroy();
    }
    if (malformed > 0 || foreign > 0) {
      this.logger.warn('session event log skipped invalid lines', {
        session_id: sessionId,
        malformed,
        foreign,
      });
    }
    // 文件行序在轮换写者下不保证与 seq 一致；对外承诺按 seq 升序。
    collected.sort((a, b) => a.seq - b.seq);
    return limit !== undefined ? collected.slice(0, limit) : collected;
  }

  /**
   * 从**文件尾部**回扫，收集 `type ∈ types` 的最近若干条事件（**新 → 旧**）。
   *
   * 为什么不是 `read()`：`read()` 是「从头 / 从 `sinceSeq` 往后」的正向游标语义
   * （内部靠尾窗定位**起点**），拿它找「最后一条某类型事件」等于把整份日志流一遍
   * —— 10MB 日志 ≈100ms。本方法只读尾窗：首窗 64 KiB，读到一个窗口足以判定后即停；
   * 该窗内没有任何命中才 ×4 扩窗，最多读 `maxBytes`（缺省 4 MiB）。
   *
   * **语义边界**（调用方要按「没有数据」处理，不能当成 0）：
   * - 只认本 session 的行；返回**文件顺序上最新的 ≤limit 条**匹配记录（日志只追加，
   *   即 seq 降序）；
   * - **找到第一条就停**（不再为更老的候选扩窗）：调用方只需要「最新那条可用的」；
   * - 预算用完仍无命中 → 空数组，**不回退全量扫盘、不猜**：目标事件离尾部太远
   *   （日志很长且最近没发生过这类事件）时，本方法宁可说「不知道」；
   * - 尾部崩溃残行 / 坏行跳过；窗口起点切在记录中间的那一行不解析（不拼接）。
   *
   * 读取前等该 session 的写入队列排空，与 `read()` 同一口径（读到已落盘的数据）。
   */
  async readTailMatches(
    sessionId: string,
    types: readonly string[],
    opts: ReadTailMatchesOptions = {},
  ): Promise<TailMatches> {
    const wanted = new Set(types);
    const limit =
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(0, Math.floor(opts.limit))
        : 8;
    if (wanted.size === 0 || limit === 0) return { records: [], bytesRead: 0 };

    const state = this.writers.get(sessionId);
    if (state) {
      await state.ready.catch(() => {});
      await state.queue;
    }
    await this.draining.get(sessionId)?.catch(() => {});

    const path = sessionEventsFilePath(this.dir, sessionId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return { records: [], bytesRead: 0 };
      throw error;
    }
    if (size <= 0) return { records: [], bytesRead: 0 };

    const requested =
      typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes)
        ? Math.floor(opts.maxBytes)
        : TAIL_MATCH_MAX_BYTES;
    const maxBytes = Math.max(1, Math.min(requested, size));
    let window = Math.min(TAIL_MATCH_FIRST_BYTES, maxBytes);
    let bytesRead = 0;
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = await readWindow(path, start, length);
      // 读取期间文件变短：不猜，交给调用方按「无数据」处理。
      if (buffer === undefined) return { records: [], bytesRead };
      bytesRead += length;
      const records = scanTailWindow(buffer, start === 0, sessionId, wanted, limit);
      // 找到至少一条就停：调用方只要「最新那条可用的」，为更老的候选扩窗只会白读。
      if (records.length > 0) return { records, bytesRead };
      if (start === 0) return { records, bytesRead }; // 整份文件都看过了
      if (window >= maxBytes) return { records, bytesRead }; // 预算用完：不扫全盘
      window = Math.min(window * 4, maxBytes);
      // 已扩到「整份文件」时仍会再读一遍完整前缀：下次循环 start === 0 直接收口。
    }
  }

  /** 遍历事件；不传 sessionId 时遍历所有会话目录（按目录名排序） */
  async *iterate(sessionId?: string): AsyncGenerator<SessionEventRecord> {
    if (sessionId !== undefined) {
      for (const record of await this.read(sessionId)) yield record;
      return;
    }
    for (const id of await this.listSessions()) {
      for (const record of await this.read(id)) yield record;
    }
  }

  /** 列出有事件日志目录的 session id（解码失败按原始目录名返回） */
  async listSessions(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        ids.push(decodeURIComponent(entry.name));
      } catch {
        ids.push(entry.name);
      }
    }
    ids.sort();
    return ids;
  }

  /** 读 `index.json`；缺失/损坏返回 null（索引是缓存，可从日志重建计数） */
  async readIndex(sessionId: string): Promise<SessionLogIndex | null> {
    const path = sessionIndexFilePath(this.dir, sessionId);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(content) as SessionLogIndex;
      if (parsed.v !== 1 || typeof parsed.session_id !== 'string') return null;
      return parsed;
    } catch (error) {
      this.logger.warn('session index corrupt', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 合并写 `index.json`（进程内按 session 串行，atomicWrite + 0600）。
   * 写失败向调用方抛出；runtime 侧按 best-effort 记录，不影响 run 终态。
   */
  async updateIndex(sessionId: string, patch: SessionIndexPatch): Promise<void> {
    const state = this.getOrCreateWriter(sessionId);
    await state.ready;
    await state.queue;
    const path = sessionIndexFilePath(this.dir, sessionId);
    const existing = await this.readIndex(sessionId);
    const persisted = state.persistedSeq;
    const next: SessionLogIndex = {
      v: 1,
      session_id: sessionId,
      ...(existing?.title !== undefined ? { title: existing.title } : {}),
      ...(existing?.preview !== undefined ? { preview: existing.preview } : {}),
      ...(existing?.status !== undefined ? { status: existing.status } : {}),
      ...(existing?.started_at !== undefined ? { started_at: existing.started_at } : {}),
      updated_at: patch.updated_at ?? Date.now(),
      event_count: patch.event_count ?? persisted,
      derived_upto_seq: patch.derived_upto_seq ?? persisted,
      messages_cached: true,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.started_at !== undefined ? { started_at: patch.started_at } : {}),
    };
    await atomicWrite(path, JSON.stringify(next, null, 2), { mode: 0o600, ensureDir: true });
  }

  /**
   * 删除整个会话目录（index + events）。先关闭写句柄，
   * Windows 上打开中的文件无法删除。
   * @returns 目录是否存在（调用方据此区分 sessions_deleted 0/1）
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = await this.hasSession(sessionId);
    // 先等 LRU 淘汰留下的 drain 与当前 writer 队列，再删目录。
    await this.draining.get(sessionId)?.catch(() => {});
    const state = this.writers.get(sessionId);
    if (state) {
      await state.queue;
      await state.ready.catch(() => {});
      try {
        await state.handle?.close();
      } catch {
        // 已关闭 / 已删除
      }
      state.closed = true;
      state.handle = undefined;
      this.writers.delete(sessionId);
    }
    if (!existed) return false;
    await rm(sessionDirPath(this.dir, sessionId), { recursive: true, force: true });
    return true;
  }

  /** 关闭全部写句柄；幂等 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.draining.values()].map((drain) => drain.catch(() => {})));
    this.draining.clear();
    await Promise.all(
      [...this.writers.values()].map(async (state) => {
        await state.queue;
        await state.ready.catch(() => {});
        try {
          await state.handle?.close();
        } catch {
          // best-effort
        }
        state.closed = true;
        state.handle = undefined;
      }),
    );
    this.writers.clear();
  }

  private getOrCreateWriter(sessionId: string): WriterState {
    // map 以原始 session_id 为键（路径编码只在读写文件时使用），
    // 保证 read/flush/lastPersistedSeq 的查找键一致。
    const key = sessionId;
    const state = this.writers.get(key);
    if (state) {
      state.lastUsed = Date.now();
      return state;
    }

    // 句柄上限：关闭最久未使用的 writer（fire-and-forget；其队列排空后关句柄）。
    if (this.writers.size >= this.maxOpenWriters) {
      let victimKey: string | undefined;
      let victim: WriterState | undefined;
      for (const [candidateKey, candidate] of this.writers) {
        if (candidateKey === key) continue;
        if (victim === undefined || candidate.lastUsed < victim.lastUsed) {
          victimKey = candidateKey;
          victim = candidate;
        }
      }
      if (victimKey !== undefined && victim !== undefined) {
        this.writers.delete(victimKey);
        // 关键顺序：先登记 drain 链，再让同一 session 的新 writer 等待它。
        const drain = (async () => {
          await victim.queue;
          await victim.ready.catch(() => {});
          try {
            await victim.handle?.close();
          } catch {
            // ignore
          }
          victim.handle = undefined;
          victim.closed = true;
        })().catch(() => {});
        this.draining.set(victimKey, drain);
        void drain.then(() => {
          if (this.draining.get(victimKey) === drain) this.draining.delete(victimKey);
        });
      }
    }

    // ready 在下面赋值；queue 先建立为空链，append 总是 await ready。
    const created: WriterState = {
      sessionId,
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      assignedSeq: 0,
      persistedSeq: 0,
      persistedCount: 0,
      expectedSize: 0,
      lastUsed: Date.now(),
      closed: false,
    };
    // 同一 session 的旧 writer 可能刚被 LRU 淘汰且仍在 drain：必须等它落盘，
    // 再从文件尾恢复 seq，否则会与在途写分配出相同 seq。
    const predecessor = this.draining.get(key);
    created.ready = (async () => {
      if (predecessor !== undefined) await predecessor;
      await this.initWriter(created);
    })().catch(async (error: unknown) => {
      // 初始化失败：保留首条错误供 append 抛出；关闭可能的句柄。
      if (this.writers.get(key) === created) this.writers.delete(key);
      try {
        await created.handle?.close();
      } catch {
        // ignore
      }
      throw error;
    });
    // 避免未 await 的 ready 触发 unhandled rejection（append 才消费结果）
    created.ready.catch(() => {});
    this.writers.set(key, created);
    return created;
  }

  /**
   * append 前与磁盘对齐：其它进程写过 / 文件被删除 / 尾部有半行。
   * - 文件被删除且本 writer 曾写过 → 抛 `SessionEventLogDeletedError`，不复活；
   * - 大小变化 → 截断半行、重读最后 seq 并单调抬高，重开句柄（防旧 inode）。
   */
  private async syncWithFile(state: WriterState): Promise<void> {
    const path = sessionEventsFilePath(this.dir, state.sessionId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (state.expectedSize > 0) throw new SessionEventLogDeletedError(state.sessionId);
      await mkdir(sessionDirPath(this.dir, state.sessionId), { recursive: true });
      state.handle = await open(path, 'a', 0o600);
      state.expectedSize = 0;
      return;
    }

    if (size === state.expectedSize) return;

    const truncatedSize = await truncatePartialTail(path, size);
    const last = await recoverLastSeq(path, truncatedSize);
    if (last > state.assignedSeq) {
      state.assignedSeq = last;
      state.persistedSeq = Math.max(state.persistedSeq, last);
      state.persistedCount = Math.max(state.persistedCount, last);
    }
    state.expectedSize = truncatedSize;
    // 文件可能被替换（删除后重建），旧句柄指向旧 inode；重开 append 句柄。
    try {
      await state.handle?.close();
    } catch {
      // ignore
    }
    state.handle = await open(path, 'a', 0o600);
  }

  private async initWriter(state: WriterState): Promise<void> {
    const dir = sessionDirPath(this.dir, state.sessionId);
    await mkdir(dir, { recursive: true });
    const path = sessionEventsFilePath(this.dir, state.sessionId);

    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (size > 0) {
      size = await truncatePartialTail(path, size);
      state.assignedSeq = await recoverLastSeq(path, size);
      state.persistedSeq = state.assignedSeq;
      state.persistedCount = state.assignedSeq;
    }

    const handle = await open(path, 'a', 0o600);
    try {
      // 已存在文件不经过 open 的 mode；显式收紧（Windows 上 best-effort）。
      await chmod(path, 0o600);
    } catch {
      // Windows 无 POSIX mode
    }
    state.handle = handle;
    state.expectedSize = size;
    state.lastUsed = Date.now();
  }
}

/** 删除旧的孤儿 run trace 文件（`<trace_dir>/<session_id>.jsonl`，0.5 删除语义遗留） */
export async function removeLegacySessionTrace(
  traceDir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await unlink(join(traceDir, `${encodeSessionDirName(sessionId)}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

/** 供调用方检查目录存在（不构造完整日志实例） */
export async function sessionLogDirExists(
  sessionsDir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    return (await stat(sessionDirPath(sessionsDir, sessionId))).isDirectory();
  } catch {
    return false;
  }
}
