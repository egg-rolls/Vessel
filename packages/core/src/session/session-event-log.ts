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
 * 单写者：同一进程内按 session 串行；跨进程由上层 tenant / session 写锁保证。
 *
 * @module @vessel-agent/core/session
 */

import type { Dirent } from 'node:fs';
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
}

/** 尾部恢复时读取的最大窗口序列（先小后大，最后扫全文件） */
const TAIL_WINDOW_BYTES = 64 * 1024;
const TAIL_WINDOW_MAX = 4 * 1024 * 1024;

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
  handle?: FileHandle;
  closed: boolean;
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
  private readonly writers = new Map<string, WriterState>();
  private closed = false;

  constructor(options: SessionEventLogOptions) {
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new Error('SessionEventLog requires a non-empty dir');
    }
    this.dir = options.dir;
    this.logger = options.logger ?? noopLogger;
    this.durable = options.durable ?? true;
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
      await handle.write(`${JSON.stringify(record)}\n`);
      if (this.durable) await handle.sync();
      state.persistedSeq = seq;
      state.persistedCount += 1;
      return record;
    });
    state.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /** 最近一次已落盘的 seq（不等待队列） */
  lastPersistedSeq(sessionId: string): number | undefined {
    const state = this.writers.get(sessionId);
    return state !== undefined && state.persistedSeq > 0 ? state.persistedSeq : undefined;
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
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const since = typeof opts.sinceSeq === 'number' ? Math.floor(opts.sinceSeq) : undefined;
    const limit =
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(0, Math.floor(opts.limit))
        : undefined;
    if (limit === 0) return [];

    const result: SessionEventRecord[] = [];
    let malformed = 0;
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      const record = parseRecord(line);
      if (record === null) {
        malformed += 1;
        continue;
      }
      if (since !== undefined && record.seq <= since) continue;
      result.push(record);
      if (limit !== undefined && result.length >= limit) break;
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
    if (state) return state;

    // ready 在下面赋值；queue 先建立为空链，append 总是 await ready。
    const created: WriterState = {
      sessionId,
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      assignedSeq: 0,
      persistedSeq: 0,
      persistedCount: 0,
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
