/**
 * 会话事件日志（0.18，唯一真相源）。
 *
 * 布局（additive，不改旧 session 文件）：
 *   <sessions_dir>/<encodeURIComponent(session_id)>/
 *     events.ndjson   追加写、0600、每条 fsync
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
import {
  encodeSessionDirName,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
} from '../tenant/tenant-paths.js';
import type { SessionEventInput, SessionEventRecord, SessionIndexPatch } from '../types/event.js';
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
 * 追加写会话事件日志。
 *
 * 读写均可在同一实例上并发调用：同 session 写入串行，读取先等待该 session
 * 的写入队列排空（读到已落盘的数据）。
 */
export class SessionEventLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly durable: boolean;
  private readonly maxOpenWriters: number;
  private readonly writers = new Map<string, WriterState>();
  private closed = false;

  constructor(options: SessionEventLogOptions) {
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new Error('SessionEventLog requires a non-empty dir');
    }
    this.dir = options.dir;
    this.logger = options.logger ?? noopLogger;
    this.durable = options.durable ?? true;
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
      };
      const handle = state.handle;
      if (!handle) throw new Error('session_event_log_unavailable');
      const line = `${JSON.stringify(record)}\n`;
      const written = await handle.write(line);
      if (this.durable) await handle.sync();
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
      return;
    }
    await Promise.all([...this.writers.values()].map((state) => state.queue));
  }

  /**
   * 读取事件（按 seq 升序）。
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

    const path = sessionEventsFilePath(this.dir, sessionId);
    const since = typeof opts.sinceSeq === 'number' ? Math.floor(opts.sinceSeq) : undefined;
    const limit =
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(0, Math.floor(opts.limit))
        : undefined;
    if (limit === 0) return [];

    const result: SessionEventRecord[] = [];
    let malformed = 0;
    // 流式读取：避免把大 session 的整份 NDJSON 读进内存。
    // 设置 encoding 后 Node 的 Readable 内部用 StringDecoder，跨 chunk 的多字节字符安全。
    const stream = createReadStream(path, { encoding: 'utf8' });
    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() !== '') {
            const record = parseRecord(line);
            if (record === null) {
              malformed += 1;
            } else if (since === undefined || record.seq > since) {
              result.push(record);
              if (limit !== undefined && result.length >= limit) {
                buffer = '';
                break;
              }
            }
          }
          newline = buffer.indexOf('\n');
        }
        if (limit !== undefined && result.length >= limit) break;
      }
      // 文件末尾没有换行的残行（崩溃残留）按坏行处理。
      if (buffer.trim() !== '') {
        const record = parseRecord(buffer);
        if (record === null) malformed += 1;
        else if (
          (since === undefined || record.seq > since) &&
          (limit === undefined || result.length < limit)
        ) {
          result.push(record);
        }
      }
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    } finally {
      stream.destroy();
    }
    if (malformed > 0) {
      this.logger.warn('session event log skipped malformed lines', {
        session_id: sessionId,
        malformed,
      });
    }
    return result;
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
        void (async () => {
          await victim.queue;
          await victim.ready.catch(() => {});
          try {
            await victim.handle?.close();
          } catch {
            // ignore
          }
          victim.handle = undefined;
          victim.closed = true;
        })();
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
    created.ready = this.initWriter(created).catch(async (error: unknown) => {
      // 初始化失败：保留首条错误供 append 抛出；关闭可能的句柄。
      this.writers.delete(key);
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
