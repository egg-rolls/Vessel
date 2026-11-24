/**
 * session / run 写锁（0.15 DESIGN-0.14 §1.2）。
 *
 * 文件（0600，原子发布）：
 *   tenants/<t>/.locks/sessions/<sha16(session_id)>.lock
 *   tenants/<t>/.locks/runs/<sha16(run_id)>.lock
 * 内容：{ "pid", "started_at", "host", "session_id" | "run_id" }
 *
 * stale 规则与 tenant lock 一致：死 pid、不可解析超过 5s、跨主机超过 24h。
 * 冲突错误 `code = 'conflict'`（RPC 主码），消息前缀 `session_locked:` / `run_locked:`。
 *
 * @module vessel/session-lock
 */

import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';

/** 跨主机写锁超过该时长即视为 stale（同主机存活 pid 不适用） */
export const SESSION_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** 不可解析锁文件的宽限 */
export const SESSION_LOCK_UNPARSEABLE_GRACE_MS = 5_000;

/** 回收守卫超过该时长视为 stale */
export const SESSION_LOCK_RECLAIM_GUARD_STALE_MS = 10_000;

export type SessionLockKind = 'session' | 'run';

/** 锁文件内容（冻结形状） */
export interface SessionLockInfo {
  pid: number;
  started_at: number;
  host: string;
  session_id?: string;
  run_id?: string;
}

/** 只读锁探针（0.18 session liveness）：不创建 / 改写 / 删除文件 */
export interface SessionLockInspection {
  state: 'absent' | 'live' | 'stale' | 'unparseable';
  info?: SessionLockInfo;
}

/** 锁被其它进程持有 */
export class SessionLockedError extends Error {
  /** RPC 主码（gateway / local dispatcher 只认 conflict / forbidden 等既有码） */
  readonly code = 'conflict' as const;
  readonly reason: 'session_locked' | 'run_locked';
  readonly sessionId?: string;
  readonly runId?: string;
  readonly owner?: SessionLockInfo;

  constructor(kind: SessionLockKind, id: string, owner?: SessionLockInfo) {
    const label = kind === 'session' ? 'session' : 'run';
    const shown = owner ? ` (pid ${owner.pid} on ${owner.host})` : '';
    super(
      `${kind === 'session' ? 'session_locked' : 'run_locked'}: ${label} "${id}" ` +
        `is being written by another process${shown}. ` +
        'Stop the owning process before writing the same session.',
    );
    this.name = 'SessionLockedError';
    this.reason = kind === 'session' ? 'session_locked' : 'run_locked';
    if (kind === 'session') this.sessionId = id;
    else this.runId = id;
    if (owner) this.owner = owner;
  }
}

export interface AcquireSessionLockOptions {
  tenantDir: string;
  kind: SessionLockKind;
  id: string;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  unparseableGraceMs?: number;
}

/** 持有的锁 */
export interface SessionLock {
  readonly path: string;
  readonly info: SessionLockInfo;
  release(): Promise<void>;
  /** `process.once('exit')` 兜底 */
  releaseSync(): void;
}

/** 进程内已持有的锁（path → 引用计数），同进程重复获取不互相冲突。 */
const held = new Map<string, { lock: SessionLock; count: number }>();

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

/** 锁文件名：sha256 前 16 个 hex 字符 */
export function lockFileName(id: string): string {
  return `${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}.lock`;
}

/** session / run 锁路径 */
export function sessionLockPath(tenantDir: string, kind: SessionLockKind, id: string): string {
  return join(tenantDir, '.locks', kind === 'session' ? 'sessions' : 'runs', lockFileName(id));
}

function isLockInfo(value: unknown): value is SessionLockInfo {
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

async function readLockInfo(lockPath: string): Promise<SessionLockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    return isLockInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function unparseableIsStale(
  filePath: string,
  now: number,
  graceMs: number,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return now - info.mtimeMs > graceMs;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

function isStale(
  info: SessionLockInfo,
  now: number,
  isPidAlive: (pid: number) => boolean,
  host: string,
): boolean {
  if (!isPidAlive(info.pid)) return true;
  return info.host !== host && now - info.started_at > SESSION_LOCK_STALE_MS;
}

function matches(a: SessionLockInfo | undefined, b: SessionLockInfo): boolean {
  return a !== undefined && a.pid === b.pid && a.started_at === b.started_at && a.host === b.host;
}

function makeHandle(lockPath: string, info: SessionLockInfo): SessionLock {
  let released = false;
  return {
    path: lockPath,
    info,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        if (matches(await readLockInfo(lockPath), info)) await unlink(lockPath);
      } catch {
        // best-effort
      }
    },
    releaseSync(): void {
      if (released) return;
      released = true;
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (isLockInfo(parsed) && matches(parsed, info)) unlinkSync(lockPath);
      } catch {
        // best-effort
      }
    },
  };
}

async function publish(lockPath: string, content: string): Promise<void> {
  await writeFile(lockPath, content, { flag: 'wx', mode: 0o600 });
  // Windows 不支持 mode；尽力 chmod。
  await chmod(lockPath, 0o600).catch(() => undefined);
}

/** 回收 stale 锁；返回是否已回收。 */
async function reclaimStale(params: {
  lockPath: string;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  host: string;
  graceMs: number;
}): Promise<'reclaimed' | 'not_stale' | 'busy'> {
  const { lockPath, now, isPidAlive, host, graceMs } = params;
  const guardPath = `${lockPath}.reclaim`;
  let guard: FileHandle | undefined;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const stale = await stat(guardPath)
      .then((info) => now() - info.mtimeMs > SESSION_LOCK_RECLAIM_GUARD_STALE_MS)
      .catch(() => true);
    if (!stale) return 'busy';
    await unlink(guardPath).catch(() => {});
    try {
      guard = await open(guardPath, 'wx');
    } catch (retryError) {
      if (!isErrno(retryError, 'EEXIST')) throw retryError;
      return 'busy';
    }
  }
  try {
    const info = await readLockInfo(lockPath);
    if (info !== undefined) {
      if (!isStale(info, now(), isPidAlive, host)) return 'not_stale';
    } else if (!(await unparseableIsStale(lockPath, now(), graceMs))) {
      return 'not_stale';
    }
    await unlink(lockPath).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
    return 'reclaimed';
  } finally {
    await guard.close().catch(() => {});
    await unlink(guardPath).catch(() => {});
  }
}

/**
 * 获取 session / run 写锁。
 * 同进程重复获取同一把锁返回同一 handle（引用计数），不判定为冲突。
 * @throws SessionLockedError 另一个存活进程持有
 */
export async function acquireSessionLock(options: AcquireSessionLockOptions): Promise<SessionLock> {
  const lockPath = sessionLockPath(options.tenantDir, options.kind, options.id);
  const pid = options.pid ?? process.pid;
  const existing = held.get(lockPath);
  if (existing !== undefined && existing.lock.info.pid === pid) {
    existing.count += 1;
    return {
      path: existing.lock.path,
      info: existing.lock.info,
      release: async () => {
        existing.count -= 1;
        if (existing.count <= 0) {
          held.delete(lockPath);
          await existing.lock.release();
        }
      },
      releaseSync: () => {
        existing.count -= 1;
        if (existing.count <= 0) {
          held.delete(lockPath);
          existing.lock.releaseSync();
        }
      },
    };
  }

  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const host = options.hostname ?? os.hostname();
  const graceMs = options.unparseableGraceMs ?? SESSION_LOCK_UNPARSEABLE_GRACE_MS;
  const info: SessionLockInfo = {
    pid,
    started_at: now(),
    host,
    ...(options.kind === 'session' ? { session_id: options.id } : { run_id: options.id }),
  };
  const content = `${JSON.stringify(info)}\n`;

  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await publish(lockPath, content);
      const lock = makeHandle(lockPath, info);
      held.set(lockPath, { lock, count: 1 });
      return {
        path: lockPath,
        info,
        release: async () => {
          const entry = held.get(lockPath);
          if (entry === undefined) return;
          entry.count -= 1;
          if (entry.count <= 0) {
            held.delete(lockPath);
            await lock.release();
          }
        },
        releaseSync: () => {
          const entry = held.get(lockPath);
          if (entry === undefined) return;
          entry.count -= 1;
          if (entry.count <= 0) {
            held.delete(lockPath);
            lock.releaseSync();
          }
        },
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const owner = await readLockInfo(lockPath);
    if (owner !== undefined) {
      if (!isStale(owner, now(), isPidAlive, host)) {
        throw new SessionLockedError(options.kind, options.id, owner);
      }
    } else if (!(await unparseableIsStale(lockPath, now(), graceMs))) {
      // 宽限内不可解析：保守视为另一个进程正在写入。
      throw new SessionLockedError(options.kind, options.id);
    }

    const reclaim = await reclaimStale({ lockPath, now, isPidAlive, host, graceMs });
    if (reclaim === 'not_stale') {
      throw new SessionLockedError(options.kind, options.id, await readLockInfo(lockPath));
    }
    if (reclaim === 'busy') throw new SessionLockedError(options.kind, options.id, owner);
  }

  throw new SessionLockedError(options.kind, options.id, await readLockInfo(lockPath));
}

/**
 * 只读检查一把 session / run 写锁的状态（0.18 session liveness）。
 *
 * - `absent`：文件不存在（ENOENT）
 * - `live`：可解析且未过期
 * - `stale`：可解析且过期；或不可解析但已过宽限（可回收）
 * - `unparseable`：文件存在、不可解析且仍在宽限内（保守视为写入中）
 *
 * 不创建、不改写、不删除任何文件。
 */
export async function inspectSessionLock(
  tenantDir: string,
  kind: SessionLockKind,
  id: string,
  options: {
    now?: () => number;
    hostname?: string;
    isPidAlive?: (pid: number) => boolean;
    unparseableGraceMs?: number;
  } = {},
): Promise<SessionLockInspection> {
  const lockPath = sessionLockPath(tenantDir, kind, id);
  const now = options.now ?? Date.now;
  const info = await readLockInfo(lockPath);
  if (info !== undefined) {
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    const host = options.hostname ?? os.hostname();
    return { state: isStale(info, now(), isPidAlive, host) ? 'stale' : 'live', info };
  }
  const graceMs = options.unparseableGraceMs ?? SESSION_LOCK_UNPARSEABLE_GRACE_MS;
  const pastGrace = await unparseableIsStale(lockPath, now(), graceMs);
  let exists = false;
  try {
    await stat(lockPath);
    exists = true;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (!exists) return { state: 'absent' };
  return { state: pastGrace ? 'stale' : 'unparseable' };
}

/**
 * 进程内是否已持有某把锁（process 模式 + per-run 包装共存时避免自锁）。
 */
export function isSessionLockHeld(tenantDir: string, kind: SessionLockKind, id: string): boolean {
  return held.has(sessionLockPath(tenantDir, kind, id));
}

/** 仅测试用：清空进程内登记表（不删除文件）。 */
export function resetHeldSessionLocksForTest(): void {
  held.clear();
}
