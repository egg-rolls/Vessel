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
import { SessionCorruptError } from './file-backend.js';

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

/** 读取文件时的 ENOENT 判定（其余 IO 错误按损坏处理） */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 归属 tenant：缺失记 default */
function ownerOf(record: RunRecord): string {
  const tenantId = (record as { tenant_id?: unknown }).tenant_id;
  return tenantId === undefined || tenantId === null ? 'default' : String(tenantId);
}

/** 写前读取结果；tenant 模式下 ENOENT 之外的错误一律抛 SessionCorruptError */
type StoredRecord = { found: true; record: RunRecord } | { found: false };

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
  private readonly tenantId?: string;
  private dirReady?: Promise<void>;
  /** 同一 run 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(opts: { dir: string; tenantId?: string }) {
    if (!opts.dir) throw new Error('FileRunRecordStore requires a dir');
    this.dir = opts.dir;
    this.tenantId = opts.tenantId;
  }

  async save(record: RunRecord): Promise<void> {
    const effective = this.applyTenant(record);
    const runId = this.assertRunId(effective.run_id);
    const previous = this.pendingWrites.get(runId) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeRecord(runId, effective),
      () => this.writeRecord(runId, effective),
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
   * 加载 run 记录。
   *
   * tenant 模式下损坏文件抛 `SessionCorruptError`（归属未知，不能当成
   * 「不存在」）；非 tenant 保持 0.3 的宽松语义（损坏 → null）。
   * 这样 `delete()` 在 tenant 模式下不会把损坏文件误判为可删除。
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
    } catch (error) {
      if (this.tenantId !== undefined && !isNotFound(error)) {
        throw new SessionCorruptError(path, error);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      if (this.tenantId !== undefined) throw new SessionCorruptError(path, error);
      return null;
    }

    const record = toRunRecord(parsed);
    if (!record) {
      if (this.tenantId !== undefined) {
        throw new SessionCorruptError(path, new Error('invalid run record shape'));
      }
      return null;
    }

    return this.isForeign(record) ? null : record;
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
        if (record && !this.isForeign(record)) records.push(record);
      } catch {
        // 损坏/不可读文件跳过
      }
    }

    return selectRecords(records, opts);
  }

  /**
   * 删除 run 记录。
   *
   * tenant 模式先 `load()` 校验归属：缺失或 foreign 均直接 no-op，
   * 避免共享目录时跨 tenant 删除（与 `FileSessionStore.delete` 对称，0.8 A5）。
   * 损坏文件由 `load()` 抛 `SessionCorruptError`，此处不捕获（0.8.1）。
   */
  async delete(runId: string): Promise<void> {
    const previous = this.pendingWrites.get(runId);
    if (previous) await previous;

    if (this.tenantId !== undefined) {
      // 缺失/foreign → null（no-op）；损坏 → SessionCorruptError 向上传播。
      const record = await this.load(runId);
      if (!record) return;
    }

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

  /** 写入前补齐/校验 tenant_id；跨 tenant 直接抛错 */
  private applyTenant(record: RunRecord): RunRecord {
    if (this.tenantId === undefined) return record;
    if (record.tenant_id !== undefined && record.tenant_id !== this.tenantId) {
      throw new Error(`tenant_mismatch: record ${record.run_id} belongs to ${record.tenant_id}`);
    }
    return record.tenant_id === this.tenantId ? record : { ...record, tenant_id: this.tenantId };
  }

  /** 读取时过滤其它 tenant 的文件（缺省视为 default） */
  private isForeign(record: RunRecord): boolean {
    if (this.tenantId === undefined) return false;
    return (record.tenant_id ?? 'default') !== this.tenantId;
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

  /** 仅供 tenant 模式写前读取：损坏 / 形状非法抛 SessionCorruptError（与 load 一致） */
  private async readStored(runId: string): Promise<StoredRecord> {
    const path = this.filePath(runId);

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { found: false };
      throw new SessionCorruptError(path, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new SessionCorruptError(path, error);
    }
    const record = toRunRecord(parsed);
    if (!record) {
      throw new SessionCorruptError(path, new Error('invalid run record shape'));
    }
    return { found: true, record };
  }

  /** 写前拒绝覆盖其它 tenant 的既有记录 */
  private async assertWritableOwner(runId: string): Promise<void> {
    if (this.tenantId === undefined) return;
    const stored = await this.readStored(runId);
    if (!stored.found) return;
    if (this.isForeign(stored.record)) {
      throw new Error(`tenant_mismatch: record ${runId} belongs to ${ownerOf(stored.record)}`);
    }
  }

  private async writeRecord(runId: string, record: RunRecord): Promise<void> {
    await this.ensureDir();
    await this.assertWritableOwner(runId);
    await atomicWrite(this.filePath(runId), JSON.stringify(toStoredRunRecord(record), null, 2));
  }
}
