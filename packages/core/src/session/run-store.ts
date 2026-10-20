/**
 * RunStore 实现（0.3 C1）
 *
 * - `MemoryRunStore`：进程内 Map，测试与短生命周期嵌入。
 * - `FileRunStore`：每 run 一个 JSON 文件；同 run 写入串行；temp + rename 原子写。
 *
 * @module @vessel-agent/core/session
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCheckpoint, RunStore } from '../types/run-store.js';
import { atomicWrite } from './atomic-write.js';
import { SessionCorruptError } from './file-backend.js';

export type { RunCheckpoint, RunResumeCode, RunStore } from '../types/run-store.js';
export {
  RUN_INTERRUPT_REASONS,
  RunAlreadyRunningError,
  RunResumeError,
} from '../types/run-store.js';

/** list 的默认与最大返回条数（DECISION-008 Addendum A-4） */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

/** 排序：updated_at 倒序，同值 run_id 升序 */
function compareCheckpoints(a: RunCheckpoint, b: RunCheckpoint): number {
  if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
  if (a.run_id === b.run_id) return 0;
  return a.run_id < b.run_id ? -1 : 1;
}

/** 按 opts 过滤并排序（两个实现共用，保证语义一致） */
function selectCheckpoints(
  checkpoints: Iterable<RunCheckpoint>,
  opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    offset?: number;
  },
): RunCheckpoint[] {
  const limit = resolveLimit(opts?.limit);
  if (limit === 0) return [];
  const offset = resolveOffset(opts?.offset);

  const filtered: RunCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    if (opts?.status !== undefined && checkpoint.status !== opts.status) continue;
    if (opts?.session_id !== undefined && checkpoint.session_id !== opts.session_id) continue;
    filtered.push(structuredClone(checkpoint));
  }
  filtered.sort(compareCheckpoints);
  return filtered.slice(offset, offset + limit);
}

/** 轻量形状校验：损坏/旧格式文件按不存在处理 */
function isRunCheckpoint(value: unknown): value is RunCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.run_id !== 'string' || record.run_id.length === 0) return false;
  if (typeof record.session_id !== 'string') return false;
  if (
    record.status !== 'running' &&
    record.status !== 'interrupted' &&
    record.status !== 'completed' &&
    record.status !== 'failed' &&
    record.status !== 'cancelled'
  ) {
    return false;
  }
  if (!Array.isArray(record.messages)) return false;
  if (typeof record.created_at !== 'number' || typeof record.updated_at !== 'number') return false;
  return true;
}

/** 进程内实现 */
export class MemoryRunStore implements RunStore {
  private readonly checkpoints = new Map<string, RunCheckpoint>();

  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.run_id, structuredClone(checkpoint));
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    const checkpoint = this.checkpoints.get(runId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async list(opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<RunCheckpoint[]> {
    return selectCheckpoints(this.checkpoints.values(), opts);
  }

  async delete(runId: string): Promise<void> {
    this.checkpoints.delete(runId);
  }

  async close(): Promise<void> {
    // no-op: memory store has no persistent connection
  }
}

/** 文件实现：`{dir}/{encodeURIComponent(run_id)}.json` */
export class FileRunStore implements RunStore {
  private readonly dir: string;
  private readonly tenantId?: string;
  private dirReady?: Promise<void>;
  /** 同一 run 的写入串行化；值为永不 reject 的 tail */
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(opts: { dir: string; tenantId?: string }) {
    if (!opts.dir) throw new Error('FileRunStore requires a dir');
    this.dir = opts.dir;
    this.tenantId = opts.tenantId;
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const effective = this.applyTenant(checkpoint);
    const runId = this.assertRunId(effective.run_id);
    const previous = this.pendingWrites.get(runId) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeCheckpoint(runId, effective),
      () => this.writeCheckpoint(runId, effective),
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
   * 加载 checkpoint。
   *
   * tenant 模式下损坏文件抛 `SessionCorruptError`（归属未知，不能当成
   * 「不存在」）；非 tenant 保持 0.3 的宽松语义（损坏 → null）。
   * 这样 `delete()` 在 tenant 模式下不会把损坏文件误判为可删除。
   */
  async load(runId: string): Promise<RunCheckpoint | null> {
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

    if (!isRunCheckpoint(parsed)) {
      if (this.tenantId !== undefined) {
        throw new SessionCorruptError(path, new Error('invalid run checkpoint shape'));
      }
      return null;
    }

    return this.isForeign(parsed) ? null : parsed;
  }

  async list(opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<RunCheckpoint[]> {
    const limit = resolveLimit(opts?.limit);
    if (limit === 0) return [];

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }

    const checkpoints: RunCheckpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
      try {
        const content = await readFile(join(this.dir, entry), 'utf8');
        const parsed: unknown = JSON.parse(content);
        if (isRunCheckpoint(parsed) && !this.isForeign(parsed)) checkpoints.push(parsed);
      } catch {
        // 损坏/不可读文件跳过
      }
    }

    return selectCheckpoints(checkpoints, opts);
  }

  /**
   * 删除 checkpoint。
   *
   * tenant 模式先 `load()` 校验归属：缺失或 foreign 均直接 no-op，
   * 避免共享目录时跨 tenant 删除（与 `FileSessionBackend.delete` 对称，0.8 A5）。
   * 损坏文件由 `load()` 抛 `SessionCorruptError`，此处不捕获（0.8.1）。
   */
  async delete(runId: string): Promise<void> {
    const previous = this.pendingWrites.get(runId);
    if (previous) await previous;

    if (this.tenantId !== undefined) {
      // 缺失/foreign → null（no-op）；损坏 → SessionCorruptError 向上传播。
      const checkpoint = await this.load(runId);
      if (!checkpoint) return;
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
  private applyTenant(checkpoint: RunCheckpoint): RunCheckpoint {
    if (this.tenantId === undefined) return checkpoint;
    if (checkpoint.tenant_id !== undefined && checkpoint.tenant_id !== this.tenantId) {
      throw new Error(
        `tenant_mismatch: checkpoint ${checkpoint.run_id} belongs to ${checkpoint.tenant_id}`,
      );
    }
    return checkpoint.tenant_id === this.tenantId
      ? checkpoint
      : { ...checkpoint, tenant_id: this.tenantId };
  }

  /** 读取时过滤其它 tenant 的文件（缺省视为 default） */
  private isForeign(checkpoint: RunCheckpoint): boolean {
    if (this.tenantId === undefined) return false;
    return (checkpoint.tenant_id ?? 'default') !== this.tenantId;
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

  private async writeCheckpoint(runId: string, checkpoint: RunCheckpoint): Promise<void> {
    await this.ensureDir();
    await atomicWrite(this.filePath(runId), JSON.stringify(checkpoint, null, 2));
  }
}
