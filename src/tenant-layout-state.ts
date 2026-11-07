/**
 * 单公司布局状态判定（0.49 T2 C3 / C4）
 *
 * 布局：
 *   legacy   `<dataDir>/tenants/<sid>/**`
 *   staging  `<dataDir>/.t2-migrating-<sid>/`（迁移锁 + journal）
 *   marker   `<dataDir>/.layout.json`（成功提交标记）
 *
 * 本模块只读：不做任何 rename / 写入；写侧在 `tenant-layout-migration.ts`。
 *
 * @module vessel/tenant-layout-state
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertTenantId } from '../packages/core/src/tenant/index.js';

/** marker 文件名（`<dataDir>/.layout.json`） */
export const TENANT_LAYOUT_MARKER_FILE = '.layout.json';

/** staging 目录前缀（`<dataDir>/.t2-migrating-<sid>`） */
export const TENANT_LAYOUT_STAGING_PREFIX = '.t2-migrating-';

/** journal 文件名（`<staging>/.migration.json`） */
export const TENANT_LAYOUT_JOURNAL_FILE = '.migration.json';

/** 当前布局版本（marker.layout） */
export const TENANT_LAYOUT_VERSION = 2;

/** 不迁移、随 staging 保留的 ephemeral 顶层条目（C13） */
export const TENANT_LAYOUT_EPHEMERAL_ENTRIES: readonly string[] = ['.lock', '.members', '.locks'];

/** 根布局目录存在即视为已迁移（C3.4 收养旧写入） */
export const TENANT_LAYOUT_ROOT_DIRS: readonly string[] = ['sessions', 'runs', 'events', 'inbox'];

/** 布局状态 */
export type TenantLayoutState = 'fresh' | 'legacy' | 'migrating' | 'root' | 'blocked';

/** 状态判定不得推进的 reason（stable code） */
export type TenantLayoutBlockedReason = 'layout_journal_corrupt' | 'layout_state_mixed';

/** 布局相关稳定路径 */
export interface TenantLayoutLocations {
  data_dir: string;
  single_tenant_id: string;
  /** `<dataDir>/tenants` */
  tenants_dir: string;
  /** `<dataDir>/tenants/<sid>` */
  legacy_dir: string;
  /** `<dataDir>/.t2-migrating-<sid>/` */
  staging_dir: string;
  /** `<staging>/.migration.json` */
  journal_file: string;
  /** `<dataDir>/.layout.json` */
  marker_file: string;
}

/** journal 阶段（C4，只增不改） */
export type TenantLayoutPhase =
  | 'staged'
  | 'moving'
  | 'verifying'
  | 'rolling_back'
  | 'done'
  | 'failed';

/** journal 条目状态 */
export type TenantLayoutEntryStatus = 'pending' | 'moving' | 'done';

/** journal 条目 */
export interface TenantLayoutEntry {
  /** 相对旧树根的路径；`sessions`、`sessions.db`、`tenant.json` 等 */
  rel: string;
  kind: 'dir' | 'file';
  status: TenantLayoutEntryStatus;
  /** 该条目下的文件数（文件条目为 1） */
  files: number;
  /** 该条目下的总字节 */
  bytes: number;
  /** 条目来源；回滚只处理 legacy（C8） */
  origin: 'legacy';
  /** 目标已存在空目录：逐子项合并（恢复时沿用） */
  merge?: boolean;
}

/** 抽样 sha256（verify 用；字段只增不改） */
export interface TenantLayoutHashSample {
  rel: string;
  sha256: string;
}

/** 迁移 journal（`<staging>/.migration.json`） */
export interface TenantLayoutJournal {
  version: 1;
  phase: TenantLayoutPhase;
  single_tenant_id: string;
  source: string;
  target: string;
  staging: string;
  owner: {
    pid: number;
    host: string;
    started_at: number;
  };
  started_at: number;
  updated_at: number;
  entries: TenantLayoutEntry[];
  conflicts: string[];
  error: string | null;
  /** 抽样 hash（可能在 staged 后写入；恢复时可为空） */
  verification?: {
    samples: TenantLayoutHashSample[];
  };
}

/** 成功标记（`<dataDir>/.layout.json`） */
export interface TenantLayoutMarker {
  layout: 2;
  source_tenant: string;
  migrated_at: number;
  journal: string;
}

/** 状态判定结果 */
export interface TenantLayoutStatus {
  state: TenantLayoutState;
  /** blocked 时的稳定 reason */
  reason?: TenantLayoutBlockedReason;
  locations: TenantLayoutLocations;
  /** staging 存在且 journal 可解析时给出 */
  journal?: TenantLayoutJournal;
  /** marker 存在且可解析时给出 */
  marker?: TenantLayoutMarker;
  /** marker 文件是否存在（即使不可解析） */
  marker_exists?: boolean;
  /** legacy 目录是否存在且非空 */
  legacy_exists?: boolean;
  legacy_non_empty?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** 解析布局路径；`dataDir` 统一 resolve，避免相对路径歧义 */
export function tenantLayoutLocations(
  dataDir: string,
  singleTenantId: string,
): TenantLayoutLocations {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new Error('invalid_data_dir: dataDir must be a non-empty string');
  }
  assertTenantId(singleTenantId);
  const root = resolve(dataDir);
  const staging_dir = join(root, `${TENANT_LAYOUT_STAGING_PREFIX}${singleTenantId}`);
  return {
    data_dir: root,
    single_tenant_id: singleTenantId,
    tenants_dir: join(root, 'tenants'),
    legacy_dir: join(root, 'tenants', singleTenantId),
    staging_dir,
    journal_file: join(staging_dir, TENANT_LAYOUT_JOURNAL_FILE),
    marker_file: join(root, TENANT_LAYOUT_MARKER_FILE),
  };
}

/** lstat；不存在返回 null（不跟随 symlink） */
export async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

/** 路径存在（不跟随 symlink） */
export async function pathExists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseJournalEntry(raw: unknown): TenantLayoutEntry | null {
  if (!isRecord(raw)) return null;
  const { rel, kind, status, files, bytes } = raw;
  if (typeof rel !== 'string' || rel === '') return null;
  if (kind !== 'dir' && kind !== 'file') return null;
  if (status !== 'pending' && status !== 'moving' && status !== 'done') return null;
  if (typeof files !== 'number' || !Number.isFinite(files) || files < 0) return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return {
    rel,
    kind,
    status,
    files,
    bytes,
    origin: 'legacy',
    ...(raw.merge === true ? { merge: true } : {}),
  };
}

const LAYOUT_PHASES: readonly TenantLayoutPhase[] = [
  'staged',
  'moving',
  'verifying',
  'rolling_back',
  'done',
  'failed',
];

/** 严格解析 journal；缺字段/非法值 → null（状态判定视为 corrupt） */
export function parseLayoutJournal(raw: unknown): TenantLayoutJournal | null {
  if (!isRecord(raw)) return null;
  const { version, phase, single_tenant_id, source, target, staging, owner } = raw;
  if (version !== 1) return null;
  if (typeof phase !== 'string' || !LAYOUT_PHASES.includes(phase as TenantLayoutPhase)) return null;
  if (typeof single_tenant_id !== 'string' || single_tenant_id === '') return null;
  if (typeof source !== 'string' || typeof target !== 'string' || typeof staging !== 'string') {
    return null;
  }
  if (!isRecord(owner)) return null;
  const { pid, host, started_at } = owner;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host === '') return null;
  if (typeof started_at !== 'number' || !Number.isFinite(started_at)) return null;
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
  const entries: TenantLayoutEntry[] = [];
  for (const item of rawEntries) {
    const entry = parseJournalEntry(item);
    if (entry === null) return null;
    entries.push(entry);
  }
  const rawConflicts = Array.isArray(raw.conflicts) ? raw.conflicts : [];
  const conflicts = rawConflicts.filter((item): item is string => typeof item === 'string');
  const error = typeof raw.error === 'string' ? raw.error : null;
  const journal: TenantLayoutJournal = {
    version: 1,
    phase: phase as TenantLayoutPhase,
    single_tenant_id,
    source,
    target,
    staging,
    owner: { pid, host, started_at },
    started_at: typeof raw.started_at === 'number' ? raw.started_at : started_at,
    updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : started_at,
    entries,
    conflicts,
    error,
  };
  if (isRecord(raw.verification) && Array.isArray(raw.verification.samples)) {
    const samples: TenantLayoutHashSample[] = [];
    for (const sample of raw.verification.samples) {
      if (isRecord(sample) && typeof sample.rel === 'string' && typeof sample.sha256 === 'string') {
        samples.push({ rel: sample.rel, sha256: sample.sha256 });
      }
    }
    journal.verification = { samples };
  }
  return journal;
}

/** 解析 marker；非法 → null */
export function parseLayoutMarker(raw: unknown): TenantLayoutMarker | null {
  if (!isRecord(raw)) return null;
  const { layout, source_tenant, migrated_at, journal } = raw;
  if (layout !== TENANT_LAYOUT_VERSION) return null;
  if (typeof source_tenant !== 'string' || source_tenant === '') return null;
  if (typeof migrated_at !== 'number' || !Number.isFinite(migrated_at)) return null;
  if (typeof journal !== 'string' || journal === '') return null;
  return { layout: TENANT_LAYOUT_VERSION, source_tenant, migrated_at, journal };
}

/** 读取 journal；缺失/不可解析 → null */
export async function readLayoutJournal(path: string): Promise<TenantLayoutJournal | null> {
  return parseLayoutJournal(await readJsonFile(path));
}

/** 读取 marker；缺失/不可解析 → null */
export async function readLayoutMarker(path: string): Promise<TenantLayoutMarker | null> {
  return parseLayoutMarker(await readJsonFile(path));
}

async function directoryIsNonEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    // legacy 存在但不是可读目录：保守视为有内容
    if (isErrno(error, 'ENOENT')) return false;
    return true;
  }
}

/**
 * 按 C3 顺序判定布局状态（命中即止）。
 *
 * 只读：不创建/修改任何文件；不打开 SQLite；不获取 tenant 锁。
 */
export async function detectTenantLayoutState(
  dataDir: string,
  singleTenantId: string,
): Promise<TenantLayoutStatus> {
  const locations = tenantLayoutLocations(dataDir, singleTenantId);

  // 1. staging 存在
  const stagingStat = await lstatOrNull(locations.staging_dir);
  if (stagingStat !== null) {
    if (!stagingStat.isDirectory()) {
      return { state: 'blocked', reason: 'layout_journal_corrupt', locations };
    }
    const journal = await readLayoutJournal(locations.journal_file);
    if (journal === null) {
      return { state: 'blocked', reason: 'layout_journal_corrupt', locations };
    }
    if (journal.phase === 'done') {
      const markerExists = await pathExists(locations.marker_file);
      const marker = markerExists ? await readLayoutMarker(locations.marker_file) : null;
      return {
        state: 'root',
        locations,
        journal,
        marker_exists: markerExists,
        ...(marker !== null ? { marker } : {}),
      };
    }
    return { state: 'migrating', locations, journal };
  }

  // 2. legacy 存在且非空
  const legacyStat = await lstatOrNull(locations.legacy_dir);
  const legacyExists = legacyStat !== null;
  const legacyNonEmpty =
    legacyStat !== null &&
    (legacyStat.isDirectory() ? await directoryIsNonEmpty(locations.legacy_dir) : true);
  const markerExists = await pathExists(locations.marker_file);
  const marker = markerExists ? await readLayoutMarker(locations.marker_file) : null;
  if (legacyNonEmpty) {
    if (markerExists) {
      return {
        state: 'blocked',
        reason: 'layout_state_mixed',
        locations,
        ...(marker !== null ? { marker } : {}),
        marker_exists: true,
        legacy_exists: true,
        legacy_non_empty: true,
      };
    }
    return {
      state: 'legacy',
      locations,
      marker_exists: false,
      legacy_exists: true,
      legacy_non_empty: true,
    };
  }

  // 3. marker 存在
  if (markerExists) {
    return {
      state: 'root',
      locations,
      ...(marker !== null ? { marker } : {}),
      marker_exists: true,
      legacy_exists: legacyExists,
      legacy_non_empty: false,
    };
  }

  // 4. 根布局目录存在（无 marker）→ 收养旧写入
  for (const name of TENANT_LAYOUT_ROOT_DIRS) {
    if (await pathExists(join(locations.data_dir, name))) {
      return {
        state: 'root',
        locations,
        marker_exists: false,
        legacy_exists: legacyExists,
        legacy_non_empty: false,
      };
    }
  }

  // 5. fresh
  return {
    state: 'fresh',
    locations,
    marker_exists: false,
    legacy_exists: legacyExists,
    legacy_non_empty: false,
  };
}
