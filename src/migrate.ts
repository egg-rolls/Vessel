/**
 * 迁移核心（0.5 E18 / DECISION-010 §2.6、PLAN §7.5）
 *
 * - sqlite（旧 sessions 表）或 file-v1（sessions 目录 + runs 目录）→ file-v2；
 * - 默认 dry-run；`apply` 才写，且写前获取 tenant 锁；
 * - 源只读：绝不创建/修改/删除源；
 * - 幂等：目标已存在同 session_id / run_id → skipped，不覆盖；
 * - 目标写入走 core atomicWrite。
 *
 * @module vessel/migrate
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWrite,
  type RunRecord,
  type SessionState,
  type TenantPaths,
} from '../packages/core/src/index';
import { acquireDataLock, DataLockError } from './data-lock';
import { expandHome, resolveSingleTenantPaths } from './data-paths';

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
  readonly code: 'source_not_found' | 'invalid_source' | 'data_locked';

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

const RUN_STATUSES = new Set(['running', 'interrupted', 'completed', 'failed', 'cancelled']);

function isUsage(value: unknown): value is RunRecord['usage'] {
  return (
    isRecord(value) &&
    typeof value.prompt_tokens === 'number' &&
    typeof value.completion_tokens === 'number' &&
    typeof value.total_tokens === 'number'
  );
}

interface SessionCandidate {
  session: SessionState;
  /** 旧顶层 run 字段拆出的 RunRecord；无可用 run 字段时为 undefined */
  run?: RunRecord;
}

/**
 * 规范化旧 session JSON/sqlite 行（旧 `RunState`）：拆成 `SessionState` + `RunRecord`。
 * 非法返回 undefined。
 */
function normalizeLegacySession(value: unknown): SessionCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.session_id !== 'string' || typeof value.run_id !== 'string') {
    return undefined;
  }
  if (!Array.isArray(value.messages) || typeof value.started_at !== 'number') {
    return undefined;
  }
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)) {
    return undefined;
  }

  const startedAt = value.started_at;
  const updatedAt = typeof value.updated_at === 'number' ? value.updated_at : startedAt;
  const completedAt = typeof value.completed_at === 'number' ? value.completed_at : undefined;
  const usage = isUsage(value.usage) ? value.usage : undefined;
  const error = typeof value.error === 'string' ? value.error : undefined;
  const branch = typeof value.branch === 'string' ? value.branch : undefined;
  const derivedUptoSeq =
    typeof value.derived_upto_seq === 'number' ? value.derived_upto_seq : undefined;

  const legacyRun =
    completedAt !== undefined || usage !== undefined || error !== undefined
      ? {
          ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
          ...(usage !== undefined ? { usage } : {}),
          ...(error !== undefined ? { error } : {}),
        }
      : undefined;

  const session: SessionState = {
    session_id: value.session_id,
    created_at: startedAt,
    updated_at: updatedAt,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.preview === 'string' ? { preview: value.preview } : {}),
    ...(branch !== undefined ? { created_on_branch: branch } : {}),
    messages: value.messages as SessionState['messages'],
    ...(derivedUptoSeq !== undefined ? { derived_upto_seq: derivedUptoSeq } : {}),
    status: value.status as SessionState['status'],
    last_run_id: value.run_id,
    ...(legacyRun !== undefined ? { legacy_run: legacyRun } : {}),
  };

  const record: RunRecord = {
    run_id: value.run_id,
    session_id: value.session_id,
    status: value.status as RunRecord['status'],
    created_at: startedAt,
    updated_at: completedAt ?? updatedAt,
    ...(isUsage(value.usage) ? { usage: value.usage } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(derivedUptoSeq !== undefined ? { event_cursor: derivedUptoSeq } : {}),
  };

  return { session, run: record };
}

interface RunRecordCandidate {
  record: RunRecord;
}

/** 规范化旧 RunCheckpoint；非法返回 undefined。旧 `messages` 收进只读兼容字段。 */
function normalizeRunRecord(value: unknown): RunRecordCandidate | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.run_id !== 'string' || typeof value.session_id !== 'string') {
    return undefined;
  }
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)) {
    return undefined;
  }
  if (typeof value.created_at !== 'number' || typeof value.updated_at !== 'number') {
    return undefined;
  }

  return {
    record: {
      run_id: value.run_id,
      session_id: value.session_id,
      status: value.status as RunRecord['status'],
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(typeof value.agent_id === 'string' ? { agent_id: value.agent_id } : {}),
      ...(isUsage(value.usage) ? { usage: value.usage } : {}),
      ...(typeof value.iteration === 'number' ? { iteration: value.iteration } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(typeof value.event_cursor === 'number' ? { event_cursor: value.event_cursor } : {}),
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      ...(Array.isArray(value.messages)
        ? { legacy_messages: value.messages as NonNullable<RunRecord['legacy_messages']> }
        : {}),
    },
  };
}

/** SessionState -> 磁盘形状（保留旧顶层 run 镜像键），与 FileSessionStore 写入一致。 */
function toStoredSession(state: SessionState): Record<string, unknown> {
  return {
    session_id: state.session_id,
    title: state.title,
    preview: state.preview,
    created_at: state.created_at,
    updated_at: state.updated_at,
    started_at: state.created_at,
    completed_at: state.legacy_run?.completed_at,
    status: state.status,
    usage: state.legacy_run?.usage,
    error: state.legacy_run?.error,
    branch: state.created_on_branch,
    run_id: state.last_run_id,
    messages: state.messages ?? [],
    derived_upto_seq: state.derived_upto_seq,
  };
}

/** RunRecord -> 磁盘形状（旧 reader 仍能解析 `messages`）。 */
function toStoredRunRecord(record: RunRecord): Record<string, unknown> {
  const { legacy_messages, ...rest } = record;
  return { ...rest, messages: legacy_messages ?? [] };
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
function readSqliteSessions(sourcePath: string, counts: MigrateCounts): SessionCandidate[] {
  if (!existsSync(sourcePath)) {
    throw new MigrateError('source_not_found', `sqlite source not found: ${sourcePath}`);
  }

  let db: Database | undefined;
  try {
    db = new Database(sourcePath, { readonly: true });
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
    const candidates: SessionCandidate[] = [];

    for (const row of rows) {
      if (typeof row.session_id !== 'string') {
        counts.found += 1;
        counts.invalid += 1;
        continue;
      }
      counts.found += 1;
      try {
        const candidate = normalizeLegacySession({
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
): Promise<SessionCandidate[]> {
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

  const candidates: SessionCandidate[] = [];
  for (const name of entries) {
    counts.found += 1;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sourceDir, name), 'utf8'));
      const candidate = normalizeLegacySession(parsed);
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
): Promise<RunRecordCandidate[]> {
  let entries: string[];
  try {
    const dirents = await readdir(sourceDir, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const checkpoints: RunRecordCandidate[] = [];
  for (const name of entries) {
    counts.found += 1;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(sourceDir, name), 'utf8'));
      const candidate = normalizeRunRecord(parsed);
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

  const apply = options.apply === true;
  // 0.49 T5（C6）：只写根布局；非根布局数据 fail-fast（dry-run 同样拒绝）。
  const tenantPaths: TenantPaths = resolveSingleTenantPaths(options.dataDir, options.tenantId);
  const sessions = emptyCounts();
  const runs = emptyCounts();

  const result: MigrateResult = {
    from: options.from,
    to: 'file-v2',
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

  let lock: Awaited<ReturnType<typeof acquireDataLock>> | undefined;
  if (apply) {
    try {
      lock = await acquireDataLock({
        dataDir: tenantPaths.root,
        ...(options.now ? { now: options.now } : {}),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.pid ? { pid: options.pid } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      });
    } catch (error) {
      if (error instanceof DataLockError) {
        const detail = error.message.replace(/^data_locked:\s*/, '');
        throw new MigrateError('data_locked', detail);
      }
      throw error;
    }
  }

  // 显式 runs 源优先；这些 run_id 不再从 session 顶层字段派生第二份。
  const explicitRunIds = new Set(runCandidates.map((candidate) => candidate.record.run_id));

  try {
    for (const candidate of sessionCandidates) {
      const encoded = encodeId(candidate.session.session_id);
      if (encoded === undefined) {
        sessions.invalid += 1;
        continue;
      }
      const target = join(tenantPaths.sessions_dir, `${encoded}.json`);
      const outcome = await writeIfAbsent(target, toStoredSession(candidate.session), apply);
      sessions[outcome] += 1;

      // 旧 session 顶层 run 字段 → 独立 RunRecord（或仅在 session 里留 legacy_run）。
      const derived = candidate.run;
      if (derived === undefined || explicitRunIds.has(derived.run_id)) continue;
      runs.found += 1;
      const encodedRun = encodeId(derived.run_id);
      if (encodedRun === undefined) {
        runs.invalid += 1;
        continue;
      }
      const runTarget = join(tenantPaths.runs_dir, `${encodedRun}.json`);
      const runOutcome = await writeIfAbsent(runTarget, toStoredRunRecord(derived), apply);
      runs[runOutcome] += 1;
    }

    for (const candidate of runCandidates) {
      const encoded = encodeId(candidate.record.run_id);
      if (encoded === undefined) {
        runs.invalid += 1;
        continue;
      }
      const target = join(tenantPaths.runs_dir, `${encoded}.json`);
      const outcome = await writeIfAbsent(target, toStoredRunRecord(candidate.record), apply);
      runs[outcome] += 1;
    }
  } finally {
    await lock?.release();
  }

  return result;
}
