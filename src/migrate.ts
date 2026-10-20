/**
 * 迁移核心（0.5 E18 / DECISION-010 §2.6、PLAN §7.5）
 *
 * - sqlite（旧 sessions 表）或 file-v1（sessions 目录 + runs 目录）→ file-v2；
 * - 默认 dry-run；`apply` 才写，且写前获取 tenant 锁；
 * - 源只读：绝不创建/修改/删除源；
 * - 幂等：目标已存在同 session_id / run_id → skipped，不覆盖；
 * - 目标写入走 core atomicWrite，并补 tenant_id。
 *
 * @module vessel/migrate
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWrite,
  type RunCheckpoint,
  type RunState,
  resolveTenantPaths,
  type TenantPaths,
} from '../packages/core/src/index';
import { expandHome } from './data-paths';
import { acquireTenantLock, TenantLockError } from './tenant-lock';

/** 迁移源类型 */
export type MigrateFrom = 'sqlite' | 'file-v1';

/** 迁移目标类型（0.5 只有一个） */
export type MigrateTo = 'file-v2';

/** 计数 */
export interface MigrateCounts {
  found: number;
  migrated: number;
  skipped: number;
  invalid: number;
}

/** 迁移结果 */
export interface MigrateResult {
  from: MigrateFrom;
  to: MigrateTo;
  tenant_id: string;
  dry_run: boolean;
  sessions: MigrateCounts;
  runs: MigrateCounts;
}

/** 迁移选项 */
export interface MigrateOptions {
  from: MigrateFrom;
  to?: MigrateTo;
  tenantId: string;
  /** 已展开的全局数据根 */
  dataDir: string;
  /** sqlite 数据库路径 / file-v1 sessions 目录 */
  source?: string;
  /** file-v1 runs 目录；缺省 `~/.vessel/runs` */
  runsSource?: string;
  /** true 才写 */
  apply?: boolean;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 迁移失败 */
export class MigrateError extends Error {
  readonly code: 'source_not_found' | 'invalid_source' | 'tenant_locked';

  constructor(code: MigrateError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'MigrateError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyCounts(): MigrateCounts {
  return { found: 0, migrated: 0, skipped: 0, invalid: 0 };
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function encodeId(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

const RUN_STATE_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const RUN_CHECKPOINT_STATUSES = new Set([...RUN_STATE_STATUSES, 'interrupted']);

function isUsage(value: unknown): value is RunState['usage'] {
  return (
    isRecord(value) &&
    typeof value.prompt_tokens === 'number' &&
    typeof value.completion_tokens === 'number' &&
    typeof value.total_tokens === 'number'
  );
}

/** 源 tenant（缺省 = 0.4 legacy，归属由调用方补） */
function sourceTenantOf(value: Record<string, unknown>): string | undefined {
  return typeof value.tenant_id === 'string' && value.tenant_id !== ''
    ? value.tenant_id
    : undefined;
}

interface RunStateCandidate {
  state: RunState;
  /** 源数据自带的 tenant；undefined = 0.4 legacy */
  sourceTenantId?: string;
}

/** 规范化 RunState；非法返回 undefined。保留源 tenant_id，不在此处改写归属。 */
function normalizeRunState(value: unknown): RunStateCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.session_id !== 'string' || typeof value.run_id !== 'string') {
    return undefined;
  }
  if (!Array.isArray(value.messages) || typeof value.started_at !== 'number') {
    return undefined;
  }
  if (typeof value.status !== 'string' || !RUN_STATE_STATUSES.has(value.status)) {
    return undefined;
  }

  const sourceTenantId = sourceTenantOf(value);
  return {
    state: {
      run_id: value.run_id,
      session_id: value.session_id,
      messages: value.messages as RunState['messages'],
      started_at: value.started_at,
      status: value.status as RunState['status'],
      ...(typeof value.completed_at === 'number' ? { completed_at: value.completed_at } : {}),
      ...(isUsage(value.usage) ? { usage: value.usage } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.preview === 'string' ? { preview: value.preview } : {}),
      ...(typeof value.updated_at === 'number' ? { updated_at: value.updated_at } : {}),
      ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
      ...(sourceTenantId !== undefined ? { tenant_id: sourceTenantId } : {}),
    },
    ...(sourceTenantId !== undefined ? { sourceTenantId } : {}),
  };
}

interface RunCheckpointCandidate {
  checkpoint: RunCheckpoint;
  sourceTenantId?: string;
}

/** 规范化 RunCheckpoint；非法返回 undefined。保留源 tenant_id。 */
function normalizeRunCheckpoint(value: unknown): RunCheckpointCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.run_id !== 'string' || typeof value.session_id !== 'string') {
    return undefined;
  }
  if (!Array.isArray(value.messages)) return undefined;
  if (typeof value.status !== 'string' || !RUN_CHECKPOINT_STATUSES.has(value.status)) {
    return undefined;
  }
  if (typeof value.created_at !== 'number' || typeof value.updated_at !== 'number') {
    return undefined;
  }

  const sourceTenantId = sourceTenantOf(value);
  return {
    checkpoint: {
      run_id: value.run_id,
      session_id: value.session_id,
      status: value.status as RunCheckpoint['status'],
      messages: value.messages as RunCheckpoint['messages'],
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(typeof value.agent_id === 'string' ? { agent_id: value.agent_id } : {}),
      ...(isUsage(value.usage) ? { usage: value.usage } : {}),
      ...(typeof value.iteration === 'number' ? { iteration: value.iteration } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      ...(sourceTenantId !== undefined ? { tenant_id: sourceTenantId } : {}),
    },
    ...(sourceTenantId !== undefined ? { sourceTenantId } : {}),
  };
}

/** legacy（无 tenant）补目标 tenant；源 tenant 不同则返回 undefined（foreign → skipped） */
function assignTenant<T extends { tenant_id?: string }>(
  value: T,
  sourceTenantId: string | undefined,
  targetTenantId: string,
): T | undefined {
  if (sourceTenantId !== undefined && sourceTenantId !== targetTenantId) return undefined;
  if (sourceTenantId !== undefined) return value;
  return { ...value, tenant_id: targetTenantId };
}

/** 写入一个目标文件；返回 migrated / skipped */
async function writeIfAbsent(
  target: string,
  payload: unknown,
  apply: boolean,
): Promise<'migrated' | 'skipped'> {
  if (existsSync(target)) return 'skipped';
  if (apply) {
    await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { ensureDir: true });
  }
  return 'migrated';
}

/** 读取 sqlite sessions 表（只读，绝不创建） */
function readSqliteSessions(sourcePath: string, counts: MigrateCounts): RunStateCandidate[] {
  if (!existsSync(sourcePath)) {
    throw new MigrateError('source_not_found', `sqlite source not found: ${sourcePath}`);
  }

  let db: Database | undefined;
  try {
    db = new Database(sourcePath, { readonly: true });
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
    const candidates: RunStateCandidate[] = [];

    for (const row of rows) {
      if (typeof row.session_id !== 'string') {
        counts.found += 1;
        counts.invalid += 1;
        continue;
      }
      counts.found += 1;
      try {
        const candidate = normalizeRunState({
          run_id: row.run_id,
          session_id: row.session_id,
          messages: parseJson(row.messages),
          started_at: row.started_at,
          completed_at: row.completed_at ?? undefined,
          status: row.status,
          usage: parseJson(row.usage),
          error: row.error ?? undefined,
          title: row.title ?? undefined,
          preview: row.preview ?? undefined,
          updated_at: row.updated_at ?? undefined,
          branch: row.branch ?? undefined,
          // 0.5 源库可能已有 tenant_id；0.4 旧库没有该列 → undefined
          tenant_id: row.tenant_id ?? undefined,
        });
        if (!candidate) {
          counts.invalid += 1;
          continue;
        }
        candidates.push(candidate);
      } catch {
        counts.invalid += 1;
      }
    }
    return candidates;
  } catch (error) {
    if (error instanceof MigrateError) throw error;
    throw new MigrateError('invalid_source', `cannot read sqlite source: ${sourcePath}`);
  } finally {
    db?.close();
  }
}

/** 读取 file-v1 sessions 目录 */
async function readFileV1Sessions(
  sourceDir: string,
  counts: MigrateCounts,
): Promise<RunStateCandidate[]> {
  if (!existsSync(sourceDir)) {
    throw new MigrateError('source_not_found', `file-v1 sessions source not found: ${sourceDir}`);
  }

  let entries: string[];
  try {
    const dirents = await readdir(sourceDir, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    throw new MigrateError('invalid_source', `cannot read sessions source: ${sourceDir}`);
  }

  const candidates: RunStateCandidate[] = [];
  for (const name of entries) {
    counts.found += 1;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sourceDir, name), 'utf8'));
      const candidate = normalizeRunState(parsed);
      if (!candidate) {
        counts.invalid += 1;
        continue;
      }
      candidates.push(candidate);
    } catch {
      counts.invalid += 1;
    }
  }
  return candidates;
}

/** 读取 file-v1 runs 目录（缺失视为 0 个） */
async function readFileV1Runs(
  sourceDir: string,
  counts: MigrateCounts,
): Promise<RunCheckpointCandidate[]> {
  let entries: string[];
  try {
    const dirents = await readdir(sourceDir, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const checkpoints: RunCheckpointCandidate[] = [];
  for (const name of entries) {
    counts.found += 1;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sourceDir, name), 'utf8'));
      const candidate = normalizeRunCheckpoint(parsed);
      if (!candidate) {
        counts.invalid += 1;
        continue;
      }
      checkpoints.push(candidate);
    } catch {
      counts.invalid += 1;
    }
  }
  return checkpoints;
}

/** 默认 runs 源（file-v1） */
export function defaultRunsSource(): string {
  return expandHome('~/.vessel/runs');
}

/** 执行迁移 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  if (options.from !== 'sqlite' && options.from !== 'file-v1') {
    throw new MigrateError('invalid_source', `unsupported --from: ${String(options.from)}`);
  }
  if (options.to !== undefined && options.to !== 'file-v2') {
    throw new MigrateError('invalid_source', `unsupported --to: ${String(options.to)}`);
  }

  const tenantPaths: TenantPaths = resolveTenantPaths(options.dataDir, options.tenantId);
  const apply = options.apply === true;
  const sessions = emptyCounts();
  const runs = emptyCounts();

  const result: MigrateResult = {
    from: options.from,
    to: 'file-v2',
    tenant_id: options.tenantId,
    dry_run: !apply,
    sessions,
    runs,
  };

  // 源读取全部发生在加锁/写入之前（源只读）。
  const sessionCandidates =
    options.from === 'sqlite'
      ? readSqliteSessions(options.source ?? '.vessel/sessions.db', sessions)
      : await readFileV1Sessions(options.source ?? '.vessel/sessions', sessions);

  const runCandidates =
    options.from === 'file-v1'
      ? await readFileV1Runs(options.runsSource ?? defaultRunsSource(), runs)
      : [];

  let lock: Awaited<ReturnType<typeof acquireTenantLock>> | undefined;
  if (apply) {
    try {
      lock = await acquireTenantLock({
        tenantDir: tenantPaths.root,
        tenantId: options.tenantId,
        ...(options.now ? { now: options.now } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      });
    } catch (error) {
      if (error instanceof TenantLockError) {
        throw new MigrateError('tenant_locked', error.message);
      }
      throw error;
    }
  }

  try {
    for (const candidate of sessionCandidates) {
      const encoded = encodeId(candidate.state.session_id);
      if (encoded === undefined) {
        sessions.invalid += 1;
        continue;
      }
      // 源已有 tenant：不同归属 → skipped，绝不改写。legacy 无 tenant 才补目标值。
      const payload = assignTenant(candidate.state, candidate.sourceTenantId, options.tenantId);
      if (!payload) {
        sessions.skipped += 1;
        continue;
      }
      const target = join(tenantPaths.sessions_dir, `${encoded}.json`);
      const outcome = await writeIfAbsent(target, payload, apply);
      sessions[outcome] += 1;
    }

    for (const candidate of runCandidates) {
      const encoded = encodeId(candidate.checkpoint.run_id);
      if (encoded === undefined) {
        runs.invalid += 1;
        continue;
      }
      const payload = assignTenant(
        candidate.checkpoint,
        candidate.sourceTenantId,
        options.tenantId,
      );
      if (!payload) {
        runs.skipped += 1;
        continue;
      }
      const target = join(tenantPaths.runs_dir, `${encoded}.json`);
      const outcome = await writeIfAbsent(target, payload, apply);
      runs[outcome] += 1;
    }
  } finally {
    await lock?.release();
  }

  return result;
}
