/**
 * 单公司布局迁移引擎（0.49 T2 C5–C8）
 *
 * legacy `<dataDir>/tenants/<sid>/**` → 根布局 `<dataDir>/**`：
 *   preflight（只读）→ rename 旧树到 staging（唯一锁）→ journal → 逐项移动
 *   → verify → marker；失败/中断按 journal 回滚。
 *
 * 约束：
 * - 迁移前不构造 `SQLiteSessionStore`、不获取 tenant 写锁；
 * - preflight 不写盘；
 * - staging rename 是唯一互斥点，不新增锁文件；
 * - 非单 id 数据、冲突、EXDEV、空间不足一律 abort，不移动任何文件。
 *
 * @module vessel/tenant-layout-migration
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  rename as fsRename,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rmdir,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { atomicWrite } from '../packages/core/src/index.js';
import { collectGatewayState, isProcessAlive } from './gateway/pid';
import {
  detectTenantLayoutState,
  lstatOrNull,
  pathExists,
  readLayoutJournal,
  TENANT_LAYOUT_EPHEMERAL_ENTRIES,
  TENANT_LAYOUT_JOURNAL_FILE,
  TENANT_LAYOUT_STAGING_PREFIX,
  TENANT_LAYOUT_VERSION,
  type TenantLayoutBlockedReason,
  type TenantLayoutEntry,
  type TenantLayoutHashSample,
  type TenantLayoutJournal,
  type TenantLayoutLocations,
  type TenantLayoutState,
  type TenantLayoutStatus,
  tenantLayoutLocations,
} from './tenant-layout-state';

/** 保守磁盘余量（C5.4） */
export const TENANT_LAYOUT_FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

/** 抽样 sha256 的文件数上限 */
const HASH_SAMPLE_LIMIT = 3;

/** 抽样 sha256 的单文件大小上限（1 MiB） */
const HASH_SAMPLE_MAX_BYTES = 1024 * 1024;

/** 契约内已知的持久顶层条目（其余为未知条目，原样移动并报告） */
const KNOWN_TOP_LEVEL_ENTRIES: ReadonlySet<string> = new Set([
  'sessions',
  'runs',
  'events',
  'inbox',
  'evals',
  'tenant.json',
  'sessions.db',
  'sessions.db-wal',
  'sessions.db-shm',
]);

/** SQLite 主库（sidecar 作为独立条目单独移动） */
const SQLITE_DB_ENTRY = 'sessions.db';

/** 稳定问题码 */
export type TenantLayoutIssueCode =
  | 'legacy_tenant_data'
  | 'layout_migration_busy'
  | 'layout_cross_device'
  | 'layout_insufficient_space'
  | 'layout_target_conflict'
  | TenantLayoutBlockedReason
  | 'layout_migration_in_progress'
  | 'layout_migration_incomplete'
  | 'layout_verify_failed'
  | 'layout_migration_failed';

/** preflight / abort 问题 */
export interface TenantLayoutIssue {
  code: TenantLayoutIssueCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

/** 迁移条目计划 */
export interface TenantLayoutEntryPlan extends TenantLayoutEntry {
  /** 契约外条目：原样移动并在结果中报告（C5.7） */
  unknown: boolean;
  /** 目标已存在空目录：逐子项合并 */
  merge: boolean;
}

/** preflight 结果（只读） */
export interface TenantLayoutPreflightResult {
  ok: boolean;
  issues: TenantLayoutIssue[];
  warnings: TenantLayoutIssue[];
  entries: TenantLayoutEntryPlan[];
  free_bytes?: number;
  required_bytes?: number;
}

/** 迁移选项 */
export interface TenantLayoutMigrationOptions {
  /** 已展开的数据根 */
  dataDir: string;
  /** T1 解析出的单公司 id */
  singleTenantId: string;
  /** false = 只读 dry-run，不写任何文件；缺省 true */
  apply?: boolean;
  /** 可注入时钟 */
  now?: () => number;
  /** 覆盖 hostname（测试 / 远端判定） */
  hostname?: string;
  /** 本进程 pid：gateway 实例锁可能在 bootstrap 之前由本进程持有；缺省 `process.pid` */
  pid?: number;
  /** pid 存活判定；缺省 `process.kill(pid, 0)` 语义 */
  isPidAlive?: (pid: number) => boolean;
  /** 测试 seam：替换数据项 rename（journal/marker 原子写不受影响） */
  rename?: (from: string, to: string) => Promise<void>;
  /** 测试 seam：替换可用空间探测 */
  freeBytes?: (path: string) => Promise<number>;
  /** 测试 seam：替换 sha256 计算 */
  hashFile?: (path: string) => Promise<string>;
}

/** 迁移动作 */
export type TenantLayoutAction = 'none' | 'pending' | 'migrated' | 'rolled_forward' | 'rolled_back';

/** 迁移结果 */
export interface TenantLayoutResult {
  state: TenantLayoutState;
  action: TenantLayoutAction;
  dry_run: boolean;
  preflight?: TenantLayoutPreflightResult;
  journal?: TenantLayoutJournal;
}

/** 迁移失败（稳定 code + 结构化 issues） */
export class TenantLayoutMigrationError extends Error {
  readonly code: TenantLayoutIssueCode;
  readonly issues: TenantLayoutIssue[];

  constructor(code: TenantLayoutIssueCode, message: string, issues: TenantLayoutIssue[] = []) {
    super(message);
    this.name = 'TenantLayoutMigrationError';
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 睡眠 0ms：让出事件循环（不引入定时器等待） */
async function yieldEventLoop(): Promise<void> {
  await new Promise((resolveYield) => setTimeout(resolveYield, 0));
}

function toRel(rel: string): string {
  return rel.split(sep).join('/');
}

function assertSafeRel(rel: string): void {
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || rel.includes('/../')) {
    throw new TenantLayoutMigrationError(
      'layout_target_conflict',
      `refusing to move unsafe relative path: ${rel}`,
    );
  }
}

/** 问题聚合为一条可打印消息 */
function issuesToMessage(prefix: string, issues: TenantLayoutIssue[]): string {
  const lines = issues.map((issue) => `- [${issue.code}] ${issue.message}`);
  return [prefix, ...lines].join('\n');
}

function errorFromIssues(issues: TenantLayoutIssue[]): TenantLayoutMigrationError {
  const first = issues[0];
  const code: TenantLayoutIssueCode = first?.code ?? 'layout_migration_failed';
  return new TenantLayoutMigrationError(
    code,
    issuesToMessage('tenant layout migration blocked', issues),
    issues,
  );
}

// ---------------------------------------------------------------------------
// preflight（只读）
// ---------------------------------------------------------------------------

interface TreeCount {
  files: number;
  bytes: number;
}

/** 递归统计文件数/字节，不跟随 symlink；symlink 单独报告 */
async function countTree(path: string): Promise<TreeCount> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return { files: 0, bytes: 0 };
  if (stats.isDirectory()) {
    let files = 0;
    let bytes = 0;
    for (const child of await readdir(path)) {
      const counted = await countTree(join(path, child));
      files += counted.files;
      bytes += counted.bytes;
    }
    return { files, bytes };
  }
  return { files: 1, bytes: stats.size };
}

/** 递归收集 symlink 相对路径（不跟随） */
async function collectSymlinks(path: string, rel: string): Promise<string[]> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return [rel];
  if (!stats.isDirectory()) return [];
  const found: string[] = [];
  for (const child of await readdir(path)) {
    const childRel = rel === '' ? child : `${rel}/${child}`;
    found.push(...(await collectSymlinks(join(path, child), childRel)));
  }
  return found;
}

interface ScanEntry {
  rel: string;
  kind: 'dir' | 'file';
  files: number;
  bytes: number;
  symlinks: string[];
  unknown: boolean;
}

interface LegacyScan {
  entries: ScanEntry[];
  largestFileBytes: number;
  sqliteBytes: number;
}

async function scanLegacyTree(
  legacyDir: string,
  warnings: TenantLayoutIssue[],
): Promise<LegacyScan> {
  const entries: ScanEntry[] = [];
  let largestFileBytes = 0;
  let sqliteBytes = 0;
  for (const name of await readdir(legacyDir)) {
    if (name === TENANT_LAYOUT_JOURNAL_FILE) {
      warnings.push({
        code: 'layout_migration_incomplete',
        message: `ignoring leftover rollback journal at ${join(legacyDir, name)}`,
        path: join(legacyDir, name),
      });
      continue;
    }
    if (TENANT_LAYOUT_EPHEMERAL_ENTRIES.includes(name)) continue;
    const path = join(legacyDir, name);
    const stats = await lstat(path);
    const rel = toRel(name);
    const symlinks = await collectSymlinks(path, rel);
    const counted = await countTree(path);
    const kind: 'dir' | 'file' = stats.isDirectory() && !stats.isSymbolicLink() ? 'dir' : 'file';
    entries.push({
      rel,
      kind,
      files: counted.files,
      bytes: counted.bytes,
      symlinks,
      unknown: !KNOWN_TOP_LEVEL_ENTRIES.has(name),
    });
    if (stats.isFile() && stats.size > largestFileBytes) largestFileBytes = stats.size;
    if (name === SQLITE_DB_ENTRY || name.startsWith(`${SQLITE_DB_ENTRY}-`)) {
      sqliteBytes += counted.bytes;
    }
  }
  entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  return { entries, largestFileBytes, sqliteBytes };
}

async function directoryEntryCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return -1;
  }
}

/** C5.1：扫描 tenants/* 中的非单 id 数据 */
async function scanNonSingleTenantDirs(
  locations: TenantLayoutLocations,
  warnings: TenantLayoutIssue[],
): Promise<TenantLayoutIssue[]> {
  const issues: TenantLayoutIssue[] = [];
  let names: string[];
  try {
    names = await readdir(locations.tenants_dir);
  } catch {
    return issues;
  }
  const stagingName = `${TENANT_LAYOUT_STAGING_PREFIX}${locations.single_tenant_id}`;
  for (const name of names) {
    if (name === locations.single_tenant_id || name === stagingName) continue;
    const path = join(locations.tenants_dir, name);
    const stats = await lstatOrNull(path);
    if (stats === null) continue;
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      const entryCount = await directoryEntryCount(path);
      if (entryCount === 0) {
        warnings.push({
          code: 'legacy_tenant_data',
          message: `empty non-single tenant directory ignored: ${path}`,
          path,
        });
        continue;
      }
      const counted = await countTree(path);
      issues.push({
        code: 'legacy_tenant_data',
        message:
          `non-single tenant data at ${path} (entries=${entryCount}, ` +
          `files=${counted.files}, bytes=${counted.bytes}); archive or move it away before starting`,
        path,
        details: { entries: entryCount, files: counted.files, bytes: counted.bytes },
      });
      continue;
    }
    const counted = await countTree(path);
    issues.push({
      code: 'legacy_tenant_data',
      message:
        `non-directory entry under tenants/${name} at ${path} ` +
        `(files=${counted.files}, bytes=${counted.bytes}); archive or move it away before starting`,
      path,
      details: { files: counted.files, bytes: counted.bytes },
    });
  }
  return issues;
}

interface LockOwner {
  pid: number;
  host: string;
  source: string;
}

function parseLockOwner(raw: unknown): LockOwner | null {
  if (!isRecord(raw)) return null;
  const { pid, host } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host === '') return null;
  return { pid, host, source: '' };
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    const owner = parseLockOwner(JSON.parse(await readFile(path, 'utf8')));
    return owner === null ? null : { ...owner, source: path };
  } catch {
    return null;
  }
}

function sameHost(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const LOCK_FILE_SUFFIXES = ['.lock', '.json', '.lease'];

/** 递归收集 `.locks/**` 下的锁/租约文件（不跟随 symlink；`.tmp` 忽略） */
async function collectLockPaths(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.includes('.tmp')) continue;
      const abs = join(current, name);
      const stats = await lstatOrNull(abs);
      if (stats === null || stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (stats.isFile() && LOCK_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        found.push(abs);
      }
    }
  };
  await walk(dir);
  return found;
}

/** legacy 下的活锁（`.lock` / `.members/*.json` / `.locks/{sessions,runs,leases}/**`） */
async function scanLegacyLocks(
  legacyDir: string,
  host: string,
  isPidAlive: (pid: number) => boolean,
  selfPid: number,
): Promise<LockOwner[]> {
  const owners: LockOwner[] = [];
  const lockOwner = await readLockOwner(join(legacyDir, '.lock'));
  if (lockOwner !== null) owners.push(lockOwner);
  const membersDir = join(legacyDir, '.members');
  for (const name of await readdir(membersDir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const owner = await readLockOwner(join(membersDir, name));
    if (owner !== null) owners.push(owner);
  }
  for (const path of await collectLockPaths(join(legacyDir, '.locks'))) {
    const owner = await readLockOwner(path);
    if (owner !== null) owners.push(owner);
  }
  return owners.filter(
    (owner) => owner.pid !== selfPid && sameHost(owner.host, host) && isPidAlive(owner.pid),
  );
}

/** C5.2：活 gateway / 活 tenant 锁 */
async function detectLiveProcesses(
  locations: TenantLayoutLocations,
  options: TenantLayoutMigrationOptions,
  warnings: TenantLayoutIssue[],
): Promise<TenantLayoutIssue[]> {
  const issues: TenantLayoutIssue[] = [];
  const host = options.hostname ?? osHostname();
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const selfPid = options.pid ?? process.pid;
  let liveGateway = false;
  try {
    const snapshot = await collectGatewayState(locations.data_dir);
    // gateway 实例锁可能在 bootstrap 之前由本进程持有（`gateway start` 顺序）；
    // 只忽略本进程，其它活 pid 仍视为 busy。
    const live = snapshot.entries.filter(
      (entry) =>
        (entry.state === 'running' || entry.state === 'starting' || entry.state === 'degraded') &&
        entry.record?.pid !== selfPid &&
        entry.lock?.pid !== selfPid,
    );
    const hubLive = snapshot.hub?.state === 'running' && snapshot.hub.record?.pid !== selfPid;
    liveGateway = live.length > 0 || hubLive;
    if (liveGateway) {
      const instances = live.map((entry) => entry.instance).join(', ');
      issues.push({
        code: 'layout_migration_busy',
        message:
          `gateway is running (instances: ${instances || 'default'}); ` +
          'run `gateway stop` before starting the data layout migration',
        path: locations.data_dir,
        details: { instances },
      });
    }
  } catch (error) {
    warnings.push({
      code: 'layout_migration_busy',
      message: `could not inspect gateway state: ${errorMessage(error)}`,
      path: locations.data_dir,
    });
  }
  const liveLocks = await scanLegacyLocks(locations.legacy_dir, host, isPidAlive, selfPid);
  if (liveLocks.length > 0) {
    const description = liveLocks.map((owner) => `${owner.source} (pid ${owner.pid})`).join(', ');
    issues.push({
      code: 'layout_migration_busy',
      message:
        `tenant lock is held by a live process: ${description}; ` +
        'stop it before starting the data layout migration',
      path: locations.legacy_dir,
      details: { owners: description },
    });
  }
  return issues;
}

/** C5.3：同卷（rename 可行性） */
async function detectCrossDevice(locations: TenantLayoutLocations): Promise<TenantLayoutIssue[]> {
  try {
    const [dataStat, legacyStat] = await Promise.all([
      stat(locations.data_dir),
      stat(locations.legacy_dir),
    ]);
    if (Number(dataStat.dev) !== Number(legacyStat.dev)) {
      return [
        {
          code: 'layout_cross_device',
          message:
            `legacy tenant tree and data root are on different devices ` +
            `(${locations.legacy_dir} vs ${locations.data_dir}); ` +
            'cross-device migration is not supported',
          path: locations.legacy_dir,
        },
      ];
    }
  } catch (error) {
    return [
      {
        code: 'layout_cross_device',
        message: `could not verify same-device rename: ${errorMessage(error)}`,
        path: locations.legacy_dir,
      },
    ];
  }
  return [];
}

async function defaultFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bsize) * Number(info.bavail);
}

/** C5.4：磁盘空间（保守） */
async function detectInsufficientSpace(
  locations: TenantLayoutLocations,
  scan: LegacyScan,
  options: TenantLayoutMigrationOptions,
  warnings: TenantLayoutIssue[],
): Promise<{ issues: TenantLayoutIssue[]; free_bytes?: number; required_bytes: number }> {
  const required_bytes =
    Math.max(scan.largestFileBytes, scan.sqliteBytes) + TENANT_LAYOUT_FREE_SPACE_MARGIN_BYTES;
  const probe = options.freeBytes ?? defaultFreeBytes;
  let free_bytes: number | undefined;
  try {
    free_bytes = await probe(locations.data_dir);
  } catch (error) {
    warnings.push({
      code: 'layout_insufficient_space',
      message: `could not determine free disk space: ${errorMessage(error)}`,
      path: locations.data_dir,
    });
    return { issues: [], required_bytes };
  }
  if (free_bytes < required_bytes) {
    return {
      issues: [
        {
          code: 'layout_insufficient_space',
          message:
            `insufficient free space at ${locations.data_dir}: ` +
            `${free_bytes} bytes available, ${required_bytes} bytes required`,
          path: locations.data_dir,
          details: { free_bytes, required_bytes },
        },
      ],
      free_bytes,
      required_bytes,
    };
  }
  return { issues: [], free_bytes, required_bytes };
}

async function targetIsEmptyDirectory(path: string): Promise<boolean> {
  const stats = await lstatOrNull(path);
  if (stats === null || !stats.isDirectory()) return false;
  return (await readdir(path)).length === 0;
}

/** C5.5：冲突扫描 + 条目计划 */
async function buildEntryPlans(
  locations: TenantLayoutLocations,
  scan: LegacyScan,
): Promise<{ entries: TenantLayoutEntryPlan[]; conflicts: TenantLayoutIssue[] }> {
  const entries: TenantLayoutEntryPlan[] = [];
  const conflicts: TenantLayoutIssue[] = [];
  for (const entry of scan.entries) {
    assertSafeRel(entry.rel);
    const target = join(locations.data_dir, entry.rel);
    const targetStat = await lstatOrNull(target);
    if (entry.symlinks.length > 0) {
      conflicts.push({
        code: 'layout_target_conflict',
        message:
          `symlink in legacy tenant tree is not supported: ` +
          `${entry.symlinks.join(', ')} (under ${entry.rel})`,
        path: join(locations.legacy_dir, entry.rel),
        details: { symlinks: entry.symlinks },
      });
    }
    let merge = false;
    if (targetStat !== null) {
      if (entry.kind === 'dir' && (await targetIsEmptyDirectory(target))) {
        merge = true;
      } else {
        conflicts.push({
          code: 'layout_target_conflict',
          message:
            `target already exists and is not an empty directory: ` +
            `${target} (source ${join(locations.legacy_dir, entry.rel)})`,
          path: target,
          details: { source: join(locations.legacy_dir, entry.rel), target },
        });
      }
    }
    entries.push({
      rel: entry.rel,
      kind: entry.kind,
      status: 'pending',
      files: entry.files,
      bytes: entry.bytes,
      origin: 'legacy',
      unknown: entry.unknown,
      merge,
    });
  }
  return { entries, conflicts };
}

/**
 * C5 preflight：只读；任一硬检查失败 → `ok:false`，不移动任何文件。
 *
 * 非 legacy（fresh/root/migrating/blocked）时无条目可迁移，直接返回 ok。
 */
export async function preflightTenantLayoutMigration(
  options: TenantLayoutMigrationOptions,
): Promise<TenantLayoutPreflightResult> {
  const warnings: TenantLayoutIssue[] = [];
  const status = await detectTenantLayoutState(options.dataDir, options.singleTenantId);
  if (status.state !== 'legacy') {
    return { ok: true, issues: [], warnings, entries: [] };
  }
  const locations = status.locations;

  // 1. 非单 id 目录
  const nonSingle = await scanNonSingleTenantDirs(locations, warnings);
  if (nonSingle.length > 0) {
    return { ok: false, issues: nonSingle, warnings, entries: [] };
  }

  // 2. 活进程 / 活锁
  const busy = await detectLiveProcesses(locations, options, warnings);
  if (busy.length > 0) {
    return { ok: false, issues: busy, warnings, entries: [] };
  }

  // 3. 同卷
  const crossDevice = await detectCrossDevice(locations);
  if (crossDevice.length > 0) {
    return { ok: false, issues: crossDevice, warnings, entries: [] };
  }

  // 4–7. 扫描旧树、空间、冲突、未知条目
  const scan = await scanLegacyTree(locations.legacy_dir, warnings);
  const space = await detectInsufficientSpace(locations, scan, options, warnings);
  if (space.issues.length > 0) {
    return {
      ok: false,
      issues: space.issues,
      warnings,
      entries: [],
      ...(space.free_bytes !== undefined ? { free_bytes: space.free_bytes } : {}),
      required_bytes: space.required_bytes,
    };
  }
  const { entries, conflicts } = await buildEntryPlans(locations, scan);
  if (conflicts.length > 0) {
    return {
      ok: false,
      issues: conflicts,
      warnings,
      entries: [],
      ...(space.free_bytes !== undefined ? { free_bytes: space.free_bytes } : {}),
      required_bytes: space.required_bytes,
    };
  }
  for (const entry of entries) {
    if (entry.unknown) {
      warnings.push({
        code: 'layout_migration_incomplete',
        message: `unknown entry will be moved as-is: ${entry.rel} (${entry.files} files, ${entry.bytes} bytes)`,
        path: join(locations.legacy_dir, entry.rel),
      });
    }
    if (entry.merge) {
      warnings.push({
        code: 'layout_target_conflict',
        message: `merging ${entry.rel} into existing empty target directory`,
        path: join(locations.data_dir, entry.rel),
      });
    }
  }
  return {
    ok: true,
    issues: [],
    warnings,
    entries,
    ...(space.free_bytes !== undefined ? { free_bytes: space.free_bytes } : {}),
    required_bytes: space.required_bytes,
  };
}

// ---------------------------------------------------------------------------
// journal / marker
// ---------------------------------------------------------------------------

async function writeJournal(
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
  now: () => number,
): Promise<void> {
  journal.updated_at = now();
  await atomicWrite(locations.journal_file, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function writeLayoutMarker(
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
  migratedAt: number,
): Promise<void> {
  const marker = {
    layout: TENANT_LAYOUT_VERSION,
    source_tenant: journal.single_tenant_id,
    migrated_at: migratedAt,
    journal: locations.journal_file,
  };
  await atomicWrite(locations.marker_file, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function markEntry(
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
  entry: TenantLayoutEntry,
  status: TenantLayoutEntry['status'],
  now: () => number,
): Promise<void> {
  entry.status = status;
  await writeJournal(locations, journal, now);
}

// ---------------------------------------------------------------------------
// 移动 / 回滚 / verify
// ---------------------------------------------------------------------------

type RenameFn = (from: string, to: string) => Promise<void>;

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/** 移动单个条目（目录可合并到已存在的空目标目录） */
async function moveEntry(
  locations: TenantLayoutLocations,
  entry: TenantLayoutEntryPlan,
  rename: RenameFn,
): Promise<void> {
  const source = join(locations.staging_dir, entry.rel);
  const target = join(locations.data_dir, entry.rel);
  if (entry.kind === 'file' || !entry.merge) {
    await ensureParentDir(target);
    await rename(source, target);
    return;
  }
  const children = await readdir(source);
  for (const child of children) {
    await rename(join(source, child), join(target, child));
  }
  await rmdir(source).catch(() => {});
}

/**
 * C8 回滚：把已移动条目移回 staging，再把 staging rename 回 legacy。
 * 幂等；中断后再次进入会继续回滚。
 */
async function rollbackTenantLayoutMigration(
  options: TenantLayoutMigrationOptions,
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
): Promise<void> {
  const now = options.now ?? Date.now;
  const rename = options.rename ?? fsRename;
  journal.phase = 'rolling_back';
  await writeJournal(locations, journal, now);

  for (const entry of [...journal.entries].reverse()) {
    if (entry.origin !== 'legacy') continue;
    if (entry.status === 'pending') continue;
    assertSafeRel(entry.rel);
    const source = join(locations.staging_dir, entry.rel);
    const target = join(locations.data_dir, entry.rel);
    const targetStat = await lstatOrNull(target);
    if (targetStat === null) continue;
    const sourceStat = await lstatOrNull(source);
    entry.status = 'moving';
    await writeJournal(locations, journal, now);
    if (sourceStat === null) {
      await ensureParentDir(source);
      await rename(target, source);
    } else if (entry.kind === 'dir' && sourceStat.isDirectory() && targetStat.isDirectory()) {
      for (const child of await readdir(target)) {
        const back = join(source, child);
        if (await pathExists(back)) {
          throw new TenantLayoutMigrationError(
            'layout_migration_failed',
            `rollback conflict: both ${target} and ${back} exist`,
          );
        }
        await rename(join(target, child), back);
      }
    } else {
      throw new TenantLayoutMigrationError(
        'layout_migration_failed',
        `rollback conflict for ${entry.rel}: both ${source} and ${target} exist`,
      );
    }
    entry.status = 'pending';
    await writeJournal(locations, journal, now);
    await yieldEventLoop();
  }

  // 校验回滚后的条目数/字节与 journal 一致（此时条目已在 staging）
  for (const entry of journal.entries) {
    const restored = join(locations.staging_dir, entry.rel);
    const stats = await lstatOrNull(restored);
    if (stats === null) {
      throw new TenantLayoutMigrationError(
        'layout_migration_failed',
        `rollback incomplete: missing ${restored}`,
      );
    }
    if (entry.kind === 'file') {
      if (!stats.isFile() || stats.size !== entry.bytes) {
        throw new TenantLayoutMigrationError(
          'layout_migration_failed',
          `rollback size mismatch for ${restored}`,
        );
      }
    } else if (stats.isDirectory()) {
      const counted = await countTree(restored);
      if (counted.files !== entry.files || counted.bytes !== entry.bytes) {
        throw new TenantLayoutMigrationError(
          'layout_migration_failed',
          `rollback mismatch for ${restored}: ${counted.files} files / ${counted.bytes} bytes`,
        );
      }
    }
  }

  await rename(locations.staging_dir, locations.legacy_dir);
  await unlink(join(locations.legacy_dir, TENANT_LAYOUT_JOURNAL_FILE)).catch(() => {});
}

async function defaultHashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** 抽样 sha256：从 staging 树（排除 ephemeral）取最多 3 个小文件 */
async function collectHashSamples(
  locations: TenantLayoutLocations,
  entries: TenantLayoutEntry[],
  hashFile: (path: string) => Promise<string>,
): Promise<TenantLayoutHashSample[]> {
  const samples: TenantLayoutHashSample[] = [];
  const visit = async (absPath: string, rel: string): Promise<void> => {
    if (samples.length >= HASH_SAMPLE_LIMIT) return;
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const child of await readdir(absPath)) {
        await visit(join(absPath, child), rel === '' ? child : `${rel}/${child}`);
        if (samples.length >= HASH_SAMPLE_LIMIT) return;
      }
      return;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > HASH_SAMPLE_MAX_BYTES) return;
    const sha256 = await hashFile(absPath);
    samples.push({ rel, sha256 });
  };
  for (const entry of entries) {
    if (samples.length >= HASH_SAMPLE_LIMIT) break;
    if (TENANT_LAYOUT_EPHEMERAL_ENTRIES.includes(entry.rel)) continue;
    const absPath = join(locations.staging_dir, entry.rel);
    if (await pathExists(absPath)) await visit(absPath, entry.rel);
  }
  return samples;
}

function verifySqliteReadable(path: string): void {
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.query('SELECT count(*) AS n FROM sqlite_master').get();
  } finally {
    db.close();
  }
}

async function assertDirectoryReadable(path: string): Promise<void> {
  const names = await readdir(path);
  for (const name of names) {
    const child = join(path, name);
    const stats = await lstat(child);
    if (!stats.isFile()) continue;
    const handle = await open(child, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, 0);
    } finally {
      await handle.close();
    }
    return;
  }
}

/** C6.4 verify：条目数/文件数/字节 + 抽样 sha256 + sqlite 只读 + events 可读 */
async function verifyTenantLayoutMigration(
  options: TenantLayoutMigrationOptions,
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
): Promise<void> {
  const hashFile = options.hashFile ?? defaultHashFile;
  const fail = (message: string): never => {
    throw new TenantLayoutMigrationError('layout_verify_failed', message);
  };
  for (const entry of journal.entries) {
    const target = join(locations.data_dir, entry.rel);
    const stats = await lstatOrNull(target);
    if (stats === null) {
      throw new TenantLayoutMigrationError(
        'layout_verify_failed',
        `verify failed: missing ${target}`,
      );
    }
    if (entry.kind === 'file') {
      if (!stats.isFile() || stats.size !== entry.bytes) {
        fail(`verify failed: size mismatch for ${target}`);
      }
    } else {
      if (!stats.isDirectory()) {
        fail(`verify failed: ${target} is not a directory`);
      }
      const counted = await countTree(target);
      if (counted.files !== entry.files || counted.bytes !== entry.bytes) {
        fail(
          `verify failed: ${target} has ${counted.files} files / ${counted.bytes} bytes, ` +
            `expected ${entry.files} / ${entry.bytes}`,
        );
      }
    }
  }
  for (const sample of journal.verification?.samples ?? []) {
    const actual = await hashFile(join(locations.data_dir, sample.rel));
    if (actual !== sample.sha256) {
      fail(`verify failed: sha256 mismatch for ${sample.rel}`);
    }
  }
  const sqlitePath = join(locations.data_dir, SQLITE_DB_ENTRY);
  if (await pathExists(sqlitePath)) {
    try {
      verifySqliteReadable(sqlitePath);
    } catch (error) {
      fail(`verify failed: cannot open ${sqlitePath} read-only: ${errorMessage(error)}`);
    }
  }
  const eventsDir = join(locations.data_dir, 'events');
  if (await pathExists(eventsDir)) {
    try {
      await assertDirectoryReadable(eventsDir);
    } catch (error) {
      fail(`verify failed: events directory is not readable: ${errorMessage(error)}`);
    }
  }
  const leftovers = await readdir(locations.staging_dir);
  const allowed = new Set<string>([TENANT_LAYOUT_JOURNAL_FILE, ...TENANT_LAYOUT_EPHEMERAL_ENTRIES]);
  for (const name of leftovers) {
    if (!allowed.has(name)) {
      fail(`verify failed: unexpected leftover in staging: ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 前滚恢复 / 应用
// ---------------------------------------------------------------------------

function ownerIsAlive(
  journal: TenantLayoutJournal,
  host: string,
  isPidAlive: (pid: number) => boolean,
): boolean {
  return sameHost(journal.owner.host, host) && isPidAlive(journal.owner.pid);
}

/** C7：按 journal 前滚（不重新 rename 旧树） */
async function reconcileMovingEntries(
  locations: TenantLayoutLocations,
  journal: TenantLayoutJournal,
  rename: RenameFn,
  now: () => number,
): Promise<void> {
  for (const entry of journal.entries) {
    if (entry.status === 'done') continue;
    assertSafeRel(entry.rel);
    const source = join(locations.staging_dir, entry.rel);
    const target = join(locations.data_dir, entry.rel);
    const sourceStat = await lstatOrNull(source);
    const targetStat = await lstatOrNull(target);
    if (entry.status === 'pending') {
      await markEntry(locations, journal, entry, 'moving', now);
      await moveEntry(locations, applyPlanOf(entry), rename);
      await markEntry(locations, journal, entry, 'done', now);
      continue;
    }
    if (sourceStat === null && targetStat !== null) {
      await markEntry(locations, journal, entry, 'done', now);
      continue;
    }
    if (sourceStat !== null && targetStat === null) {
      await moveEntry(locations, applyPlanOf(entry), rename);
      await markEntry(locations, journal, entry, 'done', now);
      continue;
    }
    journal.error = `cannot reconcile moving entry ${entry.rel}`;
    throw new TenantLayoutMigrationError('layout_migration_failed', journal.error);
  }
}

function applyPlanOf(entry: TenantLayoutEntry): TenantLayoutEntryPlan {
  return {
    ...entry,
    unknown: !KNOWN_TOP_LEVEL_ENTRIES.has(entry.rel),
    merge: entry.merge === true,
  };
}

async function recoverTenantLayoutMigration(
  options: TenantLayoutMigrationOptions,
  status: TenantLayoutStatus,
): Promise<{ action: TenantLayoutAction; journal: TenantLayoutJournal }> {
  const journal = status.journal;
  if (journal === undefined) {
    throw new TenantLayoutMigrationError(
      'layout_journal_corrupt',
      `migration journal is missing or corrupt under ${status.locations.staging_dir}`,
    );
  }
  const now = options.now ?? Date.now;
  const rename = options.rename ?? fsRename;
  const host = options.hostname ?? osHostname();
  const isPidAlive = options.isPidAlive ?? isProcessAlive;
  const locations = status.locations;
  if (journal.phase === 'done') {
    if (ownerIsAlive(journal, host, isPidAlive)) {
      throw new TenantLayoutMigrationError(
        'layout_migration_in_progress',
        `layout migration is still owned by pid ${journal.owner.pid} on ${journal.owner.host}`,
      );
    }
    await writeLayoutMarker(locations, journal, now());
    return { action: 'rolled_forward', journal };
  }
  if (ownerIsAlive(journal, host, isPidAlive)) {
    throw new TenantLayoutMigrationError(
      'layout_migration_in_progress',
      `layout migration is still owned by pid ${journal.owner.pid} on ${journal.owner.host}`,
    );
  }
  if (journal.phase === 'rolling_back' || journal.phase === 'failed') {
    await rollbackTenantLayoutMigration(options, locations, journal);
    return { action: 'rolled_back', journal };
  }
  if (journal.phase === 'staged') {
    journal.phase = 'moving';
    await writeJournal(locations, journal, now);
  }
  try {
    await reconcileMovingEntries(locations, journal, rename, now);
    journal.phase = 'verifying';
    await writeJournal(locations, journal, now);
    await verifyTenantLayoutMigration(options, locations, journal);
    journal.phase = 'done';
    await writeJournal(locations, journal, now);
    await writeLayoutMarker(locations, journal, now());
    return { action: 'rolled_forward', journal };
  } catch (error) {
    journal.error = errorMessage(error);
    await rollbackTenantLayoutMigration(options, locations, journal);
    throw new TenantLayoutMigrationError(
      'layout_migration_failed',
      `layout migration recovery failed and was rolled back: ${journal.error}`,
      [],
    );
  }
}

/** C6：staging rename 独占 → journal → 逐项移动 → verify → marker */
async function applyTenantLayoutMigration(
  options: TenantLayoutMigrationOptions,
  status: TenantLayoutStatus,
  preflight: TenantLayoutPreflightResult,
): Promise<{ action: TenantLayoutAction; journal?: TenantLayoutJournal }> {
  const now = options.now ?? Date.now;
  const rename = options.rename ?? fsRename;
  const host = options.hostname ?? osHostname();
  const locations = status.locations;
  const startedAt = now();

  try {
    await rename(locations.legacy_dir, locations.staging_dir);
  } catch (error) {
    if (isErrno(error, 'EXDEV')) {
      throw new TenantLayoutMigrationError(
        'layout_cross_device',
        `staging rename failed with EXDEV: ${locations.legacy_dir} -> ${locations.staging_dir}`,
      );
    }
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EEXIST') || isErrno(error, 'ENOTEMPTY')) {
      const next = await detectTenantLayoutState(options.dataDir, options.singleTenantId);
      if (next.state === 'migrating') {
        return await recoverTenantLayoutMigration(options, next);
      }
      if (next.state === 'root') return { action: 'none' };
      throw new TenantLayoutMigrationError(
        'layout_migration_in_progress',
        `could not acquire the layout migration lock: ${errorMessage(error)}`,
      );
    }
    throw new TenantLayoutMigrationError(
      'layout_migration_failed',
      `could not stage legacy tenant tree: ${errorMessage(error)}`,
    );
  }

  // staging rename 之后、首个 journal 落盘之前的窗口：失败要还原旧树，
  // 否则会留下“有 staging 无 journal”的 blocked 状态。只还原 rename，
  // 不移动任何条目（此时尚未开始移动）。
  let journal: TenantLayoutJournal;
  try {
    const entries: TenantLayoutEntry[] = preflight.entries.map((entry) => ({
      rel: entry.rel,
      kind: entry.kind,
      status: 'pending',
      files: entry.files,
      bytes: entry.bytes,
      origin: 'legacy',
      ...(entry.merge ? { merge: true } : {}),
    }));
    journal = {
      version: 1,
      phase: 'staged',
      single_tenant_id: options.singleTenantId,
      source: locations.legacy_dir,
      target: locations.data_dir,
      staging: locations.staging_dir,
      owner: { pid: options.pid ?? process.pid, host, started_at: startedAt },
      started_at: startedAt,
      updated_at: startedAt,
      entries,
      conflicts: [],
      error: null,
    };
    journal.verification = {
      samples: await collectHashSamples(locations, entries, options.hashFile ?? defaultHashFile),
    };
    await writeJournal(locations, journal, now);
  } catch (error) {
    try {
      await rename(locations.staging_dir, locations.legacy_dir);
    } catch (restoreError) {
      throw new TenantLayoutMigrationError(
        'layout_migration_failed',
        `could not initialize migration journal (${errorMessage(error)}); ` +
          `staging left at ${locations.staging_dir} because restore failed: ${errorMessage(restoreError)}`,
      );
    }
    throw new TenantLayoutMigrationError(
      'layout_migration_failed',
      `could not initialize migration journal and restored legacy tree: ${errorMessage(error)}`,
    );
  }

  try {
    journal.phase = 'moving';
    await writeJournal(locations, journal, now);
    for (const plan of preflight.entries) {
      const entry = journal.entries.find((candidate) => candidate.rel === plan.rel);
      if (entry === undefined) continue;
      await markEntry(locations, journal, entry, 'moving', now);
      await moveEntry(locations, plan, rename);
      await markEntry(locations, journal, entry, 'done', now);
    }
    journal.phase = 'verifying';
    await writeJournal(locations, journal, now);
    await verifyTenantLayoutMigration(options, locations, journal);
    journal.phase = 'done';
    await writeJournal(locations, journal, now);
    await writeLayoutMarker(locations, journal, now());
    return { action: 'migrated', journal };
  } catch (error) {
    journal.error = errorMessage(error);
    await rollbackTenantLayoutMigration(options, locations, journal);
    const code: TenantLayoutIssueCode =
      error instanceof TenantLayoutMigrationError && error.code === 'layout_verify_failed'
        ? 'layout_verify_failed'
        : 'layout_migration_failed';
    throw new TenantLayoutMigrationError(
      code,
      `layout migration failed and was rolled back: ${journal.error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 判定并把单公司数据迁移到根布局。
 *
 * - `apply:false`（dry-run）：只读，返回状态 / preflight，不写任何文件；
 * - `apply:true`（缺省）：继续迁移或前滚恢复；失败抛
 *   `TenantLayoutMigrationError`（含稳定 code 与 issues）。
 */
export async function ensureTenantLayout(
  options: TenantLayoutMigrationOptions,
): Promise<TenantLayoutResult> {
  const apply = options.apply ?? true;
  const status = await detectTenantLayoutState(options.dataDir, options.singleTenantId);
  const state = status.state;
  switch (state) {
    case 'fresh':
      return { state, action: 'none', dry_run: !apply };
    case 'blocked': {
      const reason = status.reason ?? 'layout_journal_corrupt';
      const issue: TenantLayoutIssue = {
        code: reason,
        message:
          reason === 'layout_state_mixed'
            ? `both legacy tenant tree and ${status.locations.marker_file} exist; refusing to guess`
            : `migration journal under ${status.locations.staging_dir} is missing or corrupt`,
        path:
          reason === 'layout_state_mixed'
            ? status.locations.legacy_dir
            : status.locations.staging_dir,
      };
      if (!apply) return { state, action: 'none', dry_run: true };
      throw new TenantLayoutMigrationError(reason, issue.message, [issue]);
    }
    case 'root': {
      if (apply && status.journal?.phase === 'done' && status.marker_exists !== true) {
        await writeLayoutMarker(status.locations, status.journal, (options.now ?? Date.now)());
      }
      return {
        state,
        action: 'none',
        dry_run: !apply,
        ...(status.journal !== undefined ? { journal: status.journal } : {}),
      };
    }
    case 'migrating': {
      if (!apply) {
        return {
          state,
          action: 'pending',
          dry_run: true,
          ...(status.journal !== undefined ? { journal: status.journal } : {}),
        };
      }
      const recovered = await recoverTenantLayoutMigration(options, status);
      return {
        state,
        action: recovered.action,
        dry_run: false,
        journal: recovered.journal,
      };
    }
    case 'legacy': {
      const preflight = await preflightTenantLayoutMigration(options);
      if (!apply) {
        return {
          state,
          action: preflight.ok ? 'pending' : 'none',
          dry_run: true,
          preflight,
        };
      }
      if (!preflight.ok) throw errorFromIssues(preflight.issues);
      const applied = await applyTenantLayoutMigration(options, status, preflight);
      return {
        state,
        action: applied.action,
        dry_run: false,
        preflight,
        ...(applied.journal !== undefined ? { journal: applied.journal } : {}),
      };
    }
  }
}

/** 只读状态判定（doctor / 只读入口用） */
export async function inspectTenantLayout(
  dataDir: string,
  singleTenantId: string,
): Promise<TenantLayoutStatus> {
  return detectTenantLayoutState(dataDir, singleTenantId);
}

/** 读取 staging journal（doctor / 恢复诊断用） */
export async function readTenantLayoutJournal(
  dataDir: string,
  singleTenantId: string,
): Promise<TenantLayoutJournal | null> {
  const locations = tenantLayoutLocations(dataDir, singleTenantId);
  return readLayoutJournal(locations.journal_file);
}
