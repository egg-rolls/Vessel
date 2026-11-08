/**
 * RunRecordStore 实现（0.3 C1）
 *
 * - `MemoryRunRecordStore`：进程内 Map，测试与短生命周期嵌入。
 * - `FileRunRecordStore`：每 run 一个 JSON 文件；同 run 写入串行；temp + rename 原子写。
 *
 * 磁盘仍写 `messages` 字段（默认 `[]`）以兼容旧 reader；读取时映射为
 * 只读的 `legacy_messages`。
 *
 * @module @vessel-agent/core/session
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../types/provider.js';
import type { RunRecord, RunRecordStore, RunStatus } from '../types/run-record-store.js';
import { atomicWrite } from './atomic-write.js';

export type {
  RunRecord,
  RunRecordStore,
  RunResumeCode,
  RunStatus,
  RunUsage,
} from '../types/run-record-store.js';
export {
  RUN_INTERRUPT_REASONS,
  RunAlreadyRunningError,
  RunResumeError,
} from '../types/run-record-store.js';

/** list 的默认与最大返回条数（DECISION-008 Addendum A-4） */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 合法 run 状态（用于磁盘形状校验） */
const RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

/** 把 limit 归一化到 [0, 200]；未传用默认 50 */
function resolveLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 0), MAX_LIMIT);
}

/** 把 offset 归一化为非负整数；未传用 0 */
function resolveOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.floor(offset), 0);
}

/** 排序：updated_at 倒序，同值 run_id 升序 */
function compareRecords(a: RunRecord, b: RunRecord): number {
  if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
  if (a.run_id === b.run_id) return 0;
  return a.run_id < b.run_id ? -1 : 1;
}

/** 按 opts 过滤并排序（两个实现共用，保证语义一致） */
function selectRecords(
  records: Iterable<RunRecord>,
  opts?: {
    status?: RunStatus;
    session_id?: string;
    limit?: number;
    offset?: number;
  },
): RunRecord[] {
  const limit = resolveLimit(opts?.limit);
  if (limit === 0) return [];
  const offset = resolveOffset(opts?.offset);

  const filtered: RunRecord[] = [];
  for (const record of records) {
    if (opts?.status !== undefined && record.status !== opts.status) continue;
    if (opts?.session_id !== undefined && record.session_id !== opts.session_id) continue;
    filtered.push(structuredClone(record));
  }
  filtered.sort(compareRecords);
  return filtered.slice(offset, offset + limit);
}

/**
 * 磁盘形状校验：损坏/旧格式文件按不存在处理。
 *
 * 接受旧文件（含 `messages` 数组）与新文件（无 `messages`）。
 */
function isRunRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.run_id !== 'string' || record.run_id.length === 0) return false;
  if (typeof record.session_id !== 'string') return false;
  if (!RUN_STATUSES.has(record.status as RunStatus)) return false;
  if (record.messages !== undefined && !Array.isArray(record.messages)) return false;
  if (typeof record.created_at !== 'number' || typeof record.updated_at !== 'number') return false;
  return true;
}

/** 磁盘 -> RunRecord：旧 `messages` 映射为只读 `legacy_messages` */
function toRunRecord(value: unknown): RunRecord | null {
  if (!isRunRecord(value)) return null;
  const { messages, ...rest } = value;
  const record = rest as unknown as RunRecord;
  const legacyMessages = Array.isArray(messages)
    ? (messages as Message[])
    : Array.isArray(rest.legacy_messages)
      ? (rest.legacy_messages as Message[])
      : undefined;
  if (legacyMessages !== undefined) record.legacy_messages = legacyMessages;
  return record;
}

/** RunRecord -> 磁盘形状：`legacy_messages` 镜像为 `messages`（默认 `[]`） */
function toStoredRunRecord(record: RunRecord): Record<string, unknown> {
  const { legacy_messages, ...rest } = record;
  return { ...rest, messages: legacy_messages ?? [] };
}

/** 进程内实现 */
export class MemoryRunRecordStore implements RunRecordStore {
  private readonly records = new Map<string, RunRecord>();

  async save(record: RunRecord): Promise<void> {
    this.records.set(record.run_id, structuredClone(record));
  }

  async load(runId: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : null;
  }

  async list(opts?: {
    status?: RunStatus;
    session_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<RunRecord[]> {
    return selectRecords(this.records.values(), opts);
  }

  async delete(runId: string): Promise<void> {
    this.records.delete(runId);
  }

  async close(): Promise<void> {
    // no-op: memory store has no persistent connection
  }
}

/** 文件实现：`{dir}/{encodeURIComponent(run_id)}.json` */
export class FileRunRecordStore implements RunRecordStore {
  private readonly dir: string;
  private dirReady?: Promise<void>;
  /** 同一 run 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(opts: { dir: string }) {
    if (!opts.dir) throw new Error('FileRunRecordStore requires a dir');
    this.dir = opts.dir;
  }

  async save(record: RunRecord): Promise<void> {
    const runId = this.assertRunId(record.run_id);
    const previous = this.pendingWrites.get(runId) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeRecord(runId, record),
      () => this.writeRecord(runId, record),
    );
    const tail = current.then(
      () => {},
      () => {},
    );
    this.pendingWrites.set(runId, tail);
    try {
      await current;
    } finally {
      if (this.pendingWrites.get(runId) === tail) this.pendingWrites.delete(runId);
    }
  }

  /**
   * 加载 run 记录。损坏 / 形状非法视为不存在（0.3 宽松语义）。
   */
  async load(runId: string): Promise<RunRecord | null> {
    let path: string;
    try {
      path = this.filePath(runId);
    } catch {
      // 非法 run id 保持旧语义：视为不存在
      return null;
    }

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    return toRunRecord(parsed);
  }

  async list(opts?: {
    status?: RunStatus;
    session_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<RunRecord[]> {
    const limit = resolveLimit(opts?.limit);
    if (limit === 0) return [];

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }

    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
      try {
        const content = await readFile(join(this.dir, entry), 'utf8');
        const record = toRunRecord(JSON.parse(content));
        if (record) records.push(record);
      } catch {
        // 损坏/不可读文件跳过
      }
    }

    return selectRecords(records, opts);
  }

  /** 删除 run 记录。 */
  async delete(runId: string): Promise<void> {
    const previous = this.pendingWrites.get(runId);
    if (previous) await previous;

    try {
      await unlink(this.filePath(runId));
    } catch {
      // 文件不存在则静默忽略
    }
  }

  async close(): Promise<void> {
    // no-op: file store has no persistent connection
  }

  /** 校验并编码 run id；编码失败/空值抛错 */
  private assertRunId(runId: string): string {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('invalid_run_id: run_id must be a non-empty string');
    }
    try {
      encodeURIComponent(runId);
    } catch {
      throw new Error('invalid_run_id: run_id contains invalid characters');
    }
    return runId;
  }

  private filePath(runId: string): string {
    return join(this.dir, `${encodeURIComponent(this.assertRunId(runId))}.json`);
  }

  private async ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true })
      .then(() => {})
      .catch((error: unknown) => {
        this.dirReady = undefined;
        throw error;
      });
    return this.dirReady;
  }

  private async writeRecord(runId: string, record: RunRecord): Promise<void> {
    await this.ensureDir();
    await atomicWrite(this.filePath(runId), JSON.stringify(toStoredRunRecord(record), null, 2));
  }
}
