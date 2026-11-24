/**
 * data-dir 双层写锁（0.5 E15 / DECISION-010 §2.1、A-4 §11.6；0.15 双层锁）
 *
 * 0.49 T5：tenant 命名锁收口为中性 data-dir 写意图锁；锁文件与协议语义不变。
 *
 * 两种模式共用同一套 stale 规则：
 *   exclusive: `<dataDir>/.lock`（单写者；sqlite / migrate / trace prune / eval）
 *   shared:    `<dataDir>/.members/<pid>-<nonce>.json`（每个进程一个租约；file 后端默认）
 *
 * 锁文件内容（冻结）：
 *   { "pid": 12345, "started_at": 1760000000000, "host": "machine-name" }
 *
 * 获取：
 * 1. 先在同目录写完整临时文件，再 `link(tmp, 目标)` 原子发布；
 *    不支持硬链接的文件系统回退到 `open(目标, 'wx')` + write（空文件窗口由宽限兜底）。
 * 2. 发布后必须再检查另一侧（shared 查 `.lock`，exclusive 扫 `.members/`）；
 *    这是「晚发布方必被看见」的保证来源，双方最坏同时失败，不会双持有。
 * 3. 已有文件时读取 owner：
 *    - 不可解析 / 缺字段 → 以文件 mtime 为准，仅在超过 UNPARSEABLE_GRACE_MS 后判 stale；
 *    - pid 不存在（ESRCH）→ stale；
 *    - 同主机存活 pid → 永不过期（24h 不抢锁）；
 *    - 跨主机且 now - started_at > 24h → stale。
 * 4. stale 回收必须持 `<目标>.reclaim` 守卫，并在 unlink 前重新读取 owner；
 *    守卫超过 10s 视为 stale 可清理。
 *
 * 释放：仅当文件 pid + started_at + host 与持有者全等时才 unlink；失败 best-effort。
 *
 * @module vessel/data-lock
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import {
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';

/** 跨主机锁超过该时长即视为 stale（同主机存活 pid 不适用） */
export const DATA_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** 创建尝试次数（首次 + stale 后重试一次） */
export const DATA_LOCK_ACQUIRE_ATTEMPTS = 2;

/** 不可解析锁文件的宽限：窗口内视为“仍在写入”，不回收 */
export const DATA_LOCK_UNPARSEABLE_GRACE_MS = 5_000;

/** 回收守卫超过该时长视为 stale（守卫无数据，清理安全） */
export const DATA_LOCK_RECLAIM_GUARD_STALE_MS = 10_000;

/** 锁文件内容（冻结形状） */
export interface DataLockInfo {
  pid: number;
  started_at: number;
  host: string;
}

/** 锁模式：shared 允许多进程共存；exclusive 单写者。缺省 exclusive（兼容旧调用）。 */
export type DataLockMode = 'shared' | 'exclusive';

/** 锁被占用 */
export class DataLockError extends Error {
  readonly code = 'data_locked' as const;
  readonly dataDir: string;
  readonly owner?: DataLockInfo;

  constructor(dataDir: string, owner?: DataLockInfo) {
    super(formatLockedMessage(dataDir, owner));
    this.name = 'DataLockError';
    this.dataDir = dataDir;
    if (owner) this.owner = owner;
  }
}

function formatLockedMessage(dataDir: string, owner?: DataLockInfo): string {
  const ownerText = owner
    ? ` by pid ${owner.pid} on host ${owner.host} (started ${new Date(owner.started_at).toISOString()})`
    : '';
  return (
    `data_locked: data directory "${dataDir}" is locked${ownerText}. ` +
    'Stop the owning process, or run with `--connect <url>` (VESSEL_CONNECT) against the gateway. ' +
    'Locks with dead pids, unparseable contents older than 5s, or from another host older than 24h are reclaimed automatically.'
  );
}

/** acquireDataLock 选项 */
export interface AcquireDataLockOptions {
  /** data 根目录；不存在时创建 */
  dataDir: string;
  /** 可注入时钟（测试） */
  now?: () => number;
  hostname?: string;
  pid?: number;
  /** pid 存活判定；缺省 process.kill(pid, 0) */
  isPidAlive?: (pid: number) => boolean;
  /** 不可解析锁的宽限（测试可注入） */
  unparseableGraceMs?: number;
  /** 回收守卫 stale 阈值（测试可注入） */
  reclaimGuardStaleMs?: number;
  /** 锁模式；缺省 exclusive */
  mode?: DataLockMode;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function isLockInfo(value: unknown): value is DataLockInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.started_at === 'number' &&
    Number.isFinite(record.started_at) &&
    typeof record.host === 'string'
  );
}

/** 默认 pid 存活判定：ESRCH = 不存在；EPERM / 其他 = 保守视为存活 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    return true;
  }
}

async function readLockInfo(lockPath: string): Promise<DataLockInfo | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isLockInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 可解析锁的 stale 判定：同主机存活 pid 永不过期 */
function isStale(
  info: DataLockInfo,
  now: number,
  isPidAlive: (pid: number) => boolean,
  host: string,
): boolean {
  if (!isPidAlive(info.pid)) return true;
  return info.host !== host && now - info.started_at > DATA_LOCK_STALE_MS;
}

/**
 * 不可解析 / 空锁的 stale 判定：以文件 mtime 为准。
 * 文件已消失 → 可直接重建；其它 stat 错误保守视为“未过期”。
 */
async function unparseableLockIsStale(
  lockPath: string,
  now: number,
  graceMs: number,
): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    return now - stats.mtimeMs > graceMs;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

async function lockIsStale(
  lockPath: string,
  info: DataLockInfo | undefined,
  now: number,
  isPidAlive: (pid: number) => boolean,
  host: string,
  graceMs: number,
): Promise<boolean> {
  if (!info) return unparseableLockIsStale(lockPath, now, graceMs);
  return isStale(info, now, isPidAlive, host);
}

async function reclaimGuardIsStale(
  guardPath: string,
  now: number,
  guardStaleMs: number,
): Promise<boolean> {
  try {
    const stats = await stat(guardPath);
    return now - stats.mtimeMs > guardStaleMs;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

/**
 * 原子发布锁内容：完整写入同目录临时文件后 `link` 到锁路径。
 * `link` 不可用（非同一文件系统 / 不支持硬链接）时回退 `open(wx)` + write。
 */
async function publishLock(lockPath: string, content: string): Promise<void> {
  const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Windows 忽略 mode；best-effort chmod 保证 POSIX 上租约是 0600。
    await chmod(tmpPath, 0o600).catch(() => undefined);
    try {
      await link(tmpPath, lockPath);
      return;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) throw error;
      // 回退：文件系统不支持硬链接。
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  const handle = await open(lockPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await chmod(lockPath, 0o600).catch(() => undefined);
  } catch (error) {
    await handle.close();
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  await handle.close();
}

/** members 目录（shared 租约） */
function membersDir(dataDir: string): string {
  return join(dataDir, '.members');
}

/**
 * 扫描 `.members/`：清理 stale 租约，返回仍存活的 owner。
 * 不可解析条目按 mtime 宽限；宽限内视为仍在写入。
 */
async function pruneMembers(params: {
  dataDir: string;
  now: number;
  isPidAlive: (pid: number) => boolean;
  host: string;
  graceMs: number;
}): Promise<DataLockInfo | undefined> {
  const { dataDir, now, isPidAlive, host, graceMs } = params;
  const dir = membersDir(dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  let live: DataLockInfo | undefined;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const info = await readLockInfo(path);
    if (info === undefined) {
      if (await unparseableLockIsStale(path, now, graceMs)) {
        await unlink(path).catch((error: unknown) => {
          if (!isErrno(error, 'ENOENT')) throw error;
        });
      } else if (live === undefined) {
        // 宽限内不可解析：保守视为仍在写入，用 mtime 作为 started_at。
        const stats = await stat(path).catch(() => undefined);
        live = { pid: 0, started_at: stats?.mtimeMs ?? now, host };
      }
      continue;
    }
    if (isStale(info, now, isPidAlive, host)) {
      await unlink(path).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
      continue;
    }
    if (live === undefined) live = info;
  }
  return live;
}

/**
 * shared 发布后的检查：`.lock` 不存在 → 成功；
 * 存在但 stale → 回收一次后再检查；仍存在 → 冲突。
 */
async function ensureNoExclusiveLock(params: {
  lockPath: string;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  host: string;
  graceMs: number;
  guardStaleMs: number;
}): Promise<{ ok: true } | { ok: false; owner?: DataLockInfo }> {
  const { lockPath, now, isPidAlive, host, graceMs, guardStaleMs } = params;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = await readLockInfo(lockPath);
    if (info === undefined && !(await pathExists(lockPath))) return { ok: true };
    if (info === undefined && !(await unparseableLockIsStale(lockPath, now(), graceMs))) {
      return { ok: false };
    }
    if (info !== undefined && !isStale(info, now(), isPidAlive, host)) {
      return { ok: false, owner: info };
    }
    const reclaim = await reclaimStaleLock({
      lockPath,
      now,
      isPidAlive,
      host,
      graceMs,
      guardStaleMs,
    });
    if (reclaim.outcome === 'not_stale') return { ok: false, owner: reclaim.owner };
    if (reclaim.outcome === 'busy') return { ok: false, owner: info };
  }
  return { ok: false };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return !isErrno(error, 'ENOENT');
  }
}

async function removeMember(memberPath: string, info: DataLockInfo): Promise<void> {
  const current = await readLockInfo(memberPath);
  if (current === undefined) return;
  if (
    current.pid !== info.pid ||
    current.started_at !== info.started_at ||
    current.host !== info.host
  ) {
    return;
  }
  await unlink(memberPath).catch(() => {});
}

type ReclaimOutcome = 'reclaimed' | 'not_stale' | 'busy';

interface ReclaimResult {
  outcome: ReclaimOutcome;
  /** 复验时读到的 owner（not_stale 时会传给 DataLockError） */
  owner?: DataLockInfo;
}

/**
 * 在回收守卫内重新读取 owner，仍 stale 才 unlink。
 * 守卫保证同一时刻只有一个回收者，避免“基于旧读取删除新锁”。
 */
async function reclaimStaleLock(params: {
  lockPath: string;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  host: string;
  graceMs: number;
  guardStaleMs: number;
}): Promise<ReclaimResult> {
  const { lockPath, now, isPidAlive, host, graceMs, guardStaleMs } = params;
  const guardPath = `${lockPath}.reclaim`;

  let guard: FileHandle | undefined;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    // 另一个回收者正在工作：守卫新鲜则失败；超过阈值则清理后重试一次。
    if (!(await reclaimGuardIsStale(guardPath, now(), guardStaleMs))) {
      return { outcome: 'busy' };
    }
    await unlink(guardPath).catch(() => {});
    try {
      guard = await open(guardPath, 'wx');
    } catch (retryError) {
      if (!isErrno(retryError, 'EEXIST')) throw retryError;
      return { outcome: 'busy' };
    }
  }

  try {
    // 比较后删除：拿到守卫后重新读取，对方可能已经换上了新锁。
    const owner = await readLockInfo(lockPath);
    if (!(await lockIsStale(lockPath, owner, now(), isPidAlive, host, graceMs))) {
      return { outcome: 'not_stale', owner };
    }
    await unlink(lockPath).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
    return { outcome: 'reclaimed' };
  } finally {
    if (guard) {
      await guard.close().catch(() => {});
      // 守卫本身是空文件，删除失败无需处理。
      await unlink(guardPath).catch(() => {});
    }
  }
}

/** 已获取的 data 锁 */
export class DataLock {
  readonly info: DataLockInfo;
  readonly mode: DataLockMode;
  private readonly lockPath: string;
  private released = false;

  constructor(lockPath: string, info: DataLockInfo, mode: DataLockMode = 'exclusive') {
    this.lockPath = lockPath;
    this.info = info;
    this.mode = mode;
  }

  private matches(info: DataLockInfo | undefined): boolean {
    return (
      info !== undefined &&
      info.pid === this.info.pid &&
      info.started_at === this.info.started_at &&
      info.host === this.info.host
    );
  }

  /** 释放锁；仅当文件仍由本持有者写入时删除。失败 best-effort。 */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const current = await readLockInfo(this.lockPath);
      // pid + started_at + host 全等才删除：同一进程重新加锁时旧 handle 不得删新锁。
      if (this.matches(current)) {
        await unlink(this.lockPath);
      }
    } catch {
      // best-effort：锁文件可能已被外部清理
    }
  }

  /** `process.once('exit')` 兜底：同步删除（受 pid + started_at + host 匹配保护）。 */
  releaseSync(): void {
    if (this.released) return;
    this.released = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (isLockInfo(parsed) && this.matches(parsed)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * 获取 data-dir 单写者锁。
 * @throws DataLockError 锁被存活且未过期的进程持有
 */
export async function acquireDataLock(options: AcquireDataLockOptions): Promise<DataLock> {
  const mode = options.mode ?? 'exclusive';
  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const host = options.hostname ?? os.hostname();
  const graceMs = options.unparseableGraceMs ?? DATA_LOCK_UNPARSEABLE_GRACE_MS;
  const guardStaleMs = options.reclaimGuardStaleMs ?? DATA_LOCK_RECLAIM_GUARD_STALE_MS;
  const info: DataLockInfo = {
    pid: options.pid ?? process.pid,
    started_at: now(),
    host,
  };
  const content = `${JSON.stringify(info)}\n`;

  if (mode === 'shared') {
    await mkdir(membersDir(options.dataDir), { recursive: true });
    // 每个进程一个唯一租约；nonce 防止同 pid 同时持有两个 shared 锁。
    const memberPath = join(membersDir(options.dataDir), `${info.pid}-${randomUUID()}.json`);
    await publishLock(memberPath, content);
    let checked: Awaited<ReturnType<typeof ensureNoExclusiveLock>>;
    try {
      checked = await ensureNoExclusiveLock({
        lockPath: join(options.dataDir, '.lock'),
        now,
        isPidAlive,
        host,
        graceMs,
        guardStaleMs,
      });
    } catch (error) {
      await removeMember(memberPath, info);
      throw error;
    }
    if (checked.ok) return new DataLock(memberPath, info, 'shared');
    await removeMember(memberPath, info);
    throw new DataLockError(options.dataDir, checked.owner);
  }

  await mkdir(options.dataDir, { recursive: true });
  const lockPath = join(options.dataDir, '.lock');
  let lastOwner: DataLockInfo | undefined;

  for (let attempt = 0; attempt < DATA_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await publishLock(lockPath, content);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;

      lastOwner = await readLockInfo(lockPath);
      if (!(await lockIsStale(lockPath, lastOwner, now(), isPidAlive, host, graceMs))) {
        throw new DataLockError(options.dataDir, lastOwner);
      }

      const reclaim = await reclaimStaleLock({
        lockPath,
        now,
        isPidAlive,
        host,
        graceMs,
        guardStaleMs,
      });
      if (reclaim.outcome === 'not_stale') {
        throw new DataLockError(options.dataDir, reclaim.owner);
      }
      if (reclaim.outcome === 'busy') {
        throw new DataLockError(options.dataDir, lastOwner);
      }
      // reclaimed → 重试主循环（下一轮原子创建）。
      continue;
    }

    // 发布后扫描 shared 租约：晚发布的 shared 会在自己的检查里看到这把锁。
    let liveMember: DataLockInfo | undefined;
    try {
      liveMember = await pruneMembers({
        dataDir: options.dataDir,
        now: now(),
        isPidAlive,
        host,
        graceMs,
      });
    } catch (error) {
      await removeMember(lockPath, info);
      throw error;
    }
    if (liveMember === undefined) return new DataLock(lockPath, info);
    await removeMember(lockPath, info);
    throw new DataLockError(options.dataDir, liveMember);
  }

  throw new DataLockError(options.dataDir, lastOwner);
}

/**
 * 在 data 锁内执行写操作。
 * 若锁已由本进程持有（gateway 常驻锁 / bootstrap 写锁），直接执行，
 * 避免同一进程把自己判定为 data_locked；其它进程持锁仍抛错。
 */
export async function withDataLock<T>(
  options: AcquireDataLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  const selfPid = options.pid ?? process.pid;
  let lock: DataLock | undefined;
  try {
    lock = await acquireDataLock(options);
  } catch (error) {
    if (error instanceof DataLockError && error.owner?.pid === selfPid) {
      return action();
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
