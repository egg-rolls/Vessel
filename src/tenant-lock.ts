/**
 * tenant 单写者锁（0.5 E15 / DECISION-010 §2.1、A-4 §11.6）
 *
 * 锁文件（冻结）：
 *   { "pid": 12345, "started_at": 1760000000000, "host": "machine-name" }
 *
 * 获取：mkdir tenantDir → open(.lock, 'wx')；EEXIST 时读取 owner：
 * - 无法解析 / 缺字段 → stale
 * - pid 不存在（ESRCH）→ stale
 * - now - started_at > 24h → stale
 * - 否则 tenant_locked
 * stale 时 unlink 并重试一次（最多 2 次创建尝试）。
 *
 * 释放：仅当文件 pid 与持有者 pid 一致时 unlink；失败 best-effort。
 *
 * @module vessel/tenant-lock
 */

import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';

/** 锁超过该时长即视为 stale */
export const TENANT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** 创建尝试次数（首次 + stale 后重试一次） */
export const TENANT_LOCK_ACQUIRE_ATTEMPTS = 2;

/** 锁文件内容（冻结形状） */
export interface TenantLockInfo {
  pid: number;
  started_at: number;
  host: string;
}

/** 锁被占用 */
export class TenantLockError extends Error {
  readonly code = 'tenant_locked' as const;
  readonly tenantId: string;
  readonly owner?: TenantLockInfo;

  constructor(tenantId: string, owner?: TenantLockInfo) {
    super(formatLockedMessage(tenantId, owner));
    this.name = 'TenantLockError';
    this.tenantId = tenantId;
    if (owner) this.owner = owner;
  }
}

function formatLockedMessage(tenantId: string, owner?: TenantLockInfo): string {
  const ownerText = owner
    ? ` by pid ${owner.pid} on host ${owner.host} (started ${new Date(owner.started_at).toISOString()})`
    : '';
  return (
    `tenant_locked: tenant "${tenantId}" is locked${ownerText}. ` +
    'Stop the owning process, or run with `--connect <url>` (VESSEL_CONNECT) against the gateway. ' +
    'Locks older than 24h or with dead pids are reclaimed automatically.'
  );
}

/** acquireTenantLock 选项 */
export interface AcquireTenantLockOptions {
  /** tenant 根目录；不存在时创建 */
  tenantDir: string;
  tenantId: string;
  /** 可注入时钟（测试） */
  now?: () => number;
  hostname?: string;
  pid?: number;
  /** pid 存活判定；缺省 process.kill(pid, 0) */
  isPidAlive?: (pid: number) => boolean;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function isLockInfo(value: unknown): value is TenantLockInfo {
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

async function readLockInfo(lockPath: string): Promise<TenantLockInfo | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isLockInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isStale(
  info: TenantLockInfo | undefined,
  now: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (!info) return true;
  if (!isPidAlive(info.pid)) return true;
  return now - info.started_at > TENANT_LOCK_STALE_MS;
}

/** 已获取的 tenant 锁 */
export class TenantLock {
  readonly info: TenantLockInfo;
  private readonly lockPath: string;
  private released = false;

  constructor(lockPath: string, info: TenantLockInfo) {
    this.lockPath = lockPath;
    this.info = info;
  }

  /** 释放锁；仅当文件仍由本持有者写入时删除。失败 best-effort。 */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const current = await readLockInfo(this.lockPath);
      if (current && current.pid === this.info.pid) {
        await unlink(this.lockPath);
      }
    } catch {
      // best-effort：锁文件可能已被外部清理
    }
  }
}

/**
 * 获取 tenant 单写者锁。
 * @throws TenantLockError 锁被存活且未过期的进程持有
 */
export async function acquireTenantLock(options: AcquireTenantLockOptions): Promise<TenantLock> {
  await mkdir(options.tenantDir, { recursive: true });
  const lockPath = join(options.tenantDir, '.lock');

  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const info: TenantLockInfo = {
    pid: options.pid ?? process.pid,
    started_at: now(),
    host: options.hostname ?? os.hostname(),
  };

  let lastOwner: TenantLockInfo | undefined;

  for (let attempt = 0; attempt < TENANT_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(info)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return new TenantLock(lockPath, info);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;

      lastOwner = await readLockInfo(lockPath);
      if (!isStale(lastOwner, now(), isPidAlive)) {
        throw new TenantLockError(options.tenantId, lastOwner);
      }

      await unlink(lockPath).catch(() => {});
    }
  }

  throw new TenantLockError(options.tenantId, lastOwner);
}
