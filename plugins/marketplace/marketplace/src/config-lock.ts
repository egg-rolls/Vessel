/**
 * `~/.vessel/config.yaml` cross-process write lock
 * (CONTRACT-0.47 §1–§2).
 *
 * This is the plugin-side twin of the host's `src/config-lock.ts`; the protocol
 * is kept byte-for-byte identical. The only difference is the error type:
 * failures surface as `MarketplaceError('config_locked', ...)` so RPC callers
 * see the stable marketplace code.
 *
 * Lock file: `${configPath}.lock`, created atomically with `open(..., 'wx',
 * 0o600)`, contents `{ token, pid, acquiredAt }`. A lock older than `staleMs`
 * (default 15s) is treated as crashed and reclaimed; waiting longer than
 * `timeoutMs` (default 5s) throws `config_locked`. Same-process writers are
 * serialized per resolved lock path; re-entering the same path in the same
 * async context throws `config_locked: nested lock` instead of deadlocking.
 *
 * @module @vessel-agent/plugin-marketplace/config-lock
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { MarketplaceError } from './errors.js';

/** Default upper bound for waiting on the lock. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A lock file older than this is considered stale (owner likely crashed). */
const DEFAULT_STALE_MS = 15_000;

/** EPERM / EBUSY unlink retries while reclaiming a stale lock (Windows). */
const STALE_UNLINK_RETRIES = 3;

/** Reclaim guard suffix: `${lockPath}.reclaim`, serializes stale takeovers. */
const RECLAIM_SUFFIX = '.reclaim';

/** The guard itself only performs a few fs ops, so its stale TTL is short. */
const RECLAIM_STALE_MS = 2_000;

/** Poll backoff: 10–25ms. */
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 15;

/** Options for {@link withConfigLock}; probes only shorten the waits. */
export interface ConfigLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

interface ConfigLockInfo {
  token: string;
  pid: number;
  acquiredAt: string;
}

/** Lock paths held by the current async context (nested-lock detection). */
const activePaths = new AsyncLocalStorage<ReadonlySet<string>>();

/** Same-process serialization, keyed by resolved lock path. */
const chains = new Map<string, Promise<void>>();

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function retryDelayMs(): number {
  return RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lockedError(configPath: string, detail: string): MarketplaceError {
  return new MarketplaceError('config_locked', `config_locked: ${detail} (${configPath})`);
}

function parseLockInfo(value: unknown): ConfigLockInfo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.token !== 'string' ||
    typeof record.pid !== 'number' ||
    typeof record.acquiredAt !== 'string'
  ) {
    return undefined;
  }
  return { token: record.token, pid: record.pid, acquiredAt: record.acquiredAt };
}

/**
 * Remove a stale lock; retries EPERM / EBUSY briefly on Windows.
 * @returns whether the lock file no longer exists
 */
async function unlinkStale(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt <= STALE_UNLINK_RETRIES; attempt += 1) {
    try {
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return true;
      if ((isErrno(error, 'EPERM') || isErrno(error, 'EBUSY')) && attempt < STALE_UNLINK_RETRIES) {
        await sleep(retryDelayMs());
        continue;
      }
      return false;
    }
  }
  return false;
}

/**
 * Serialize stale takeovers: only the process holding `${lockPath}.reclaim`
 * may delete the stale lock. Without this, two reclaimers interleave
 * unlink/create and the late unlink removes the other's fresh lock, letting
 * both enter the critical section (L-047).
 *
 * @returns true when the stale lock was cleared and the caller may retry
 */
async function reclaimStale(lockPath: string, staleMs: number): Promise<boolean> {
  const guardPath = `${lockPath}${RECLAIM_SUFFIX}`;
  const guard: ConfigLockInfo = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(guardPath, 'wx', 0o600);
  } catch (error) {
    if (
      !isErrno(error, 'EEXIST') &&
      !isErrno(error, 'EPERM') &&
      !isErrno(error, 'EBUSY') &&
      !isErrno(error, 'EACCES')
    ) {
      throw error;
    }
    // Another reclaimer is working; only clear the guard when it is stale too.
    try {
      const guardStaleMs = Math.min(RECLAIM_STALE_MS, staleMs);
      if (Date.now() - (await stat(guardPath)).mtimeMs > guardStaleMs) {
        await unlinkStale(guardPath);
      }
    } catch {
      // Guard vanished or is unreadable: retry on the next iteration.
    }
    return false;
  }

  try {
    await handle.writeFile(JSON.stringify(guard), 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(guardPath).catch(() => {});
    throw error;
  }
  await handle.close().catch(() => {});

  try {
    // Re-read inside the guard: the lock may have been reclaimed and rebuilt
    // between our stat and acquiring the guard; never delete a fresh lock.
    let stillStale: boolean;
    try {
      stillStale = Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return true;
      throw error;
    }
    if (!stillStale) return false;
    await unlinkStale(lockPath);
    return true;
  } finally {
    await releaseGuard(guardPath, guard.token);
  }
}

/** Delete the guard only if its token is ours; ignore ENOENT / EPERM. */
async function releaseGuard(guardPath: string, token: string): Promise<void> {
  let info: ConfigLockInfo | undefined;
  try {
    info = parseLockInfo(JSON.parse(await readFile(guardPath, 'utf8')));
  } catch {
    return;
  }
  if (info === undefined || info.token !== token) return;
  await unlink(guardPath).catch(() => {});
}

/** Create the lock file with owner info; retries EEXIST per stale / timeout rules. */
async function acquireLock(
  lockPath: string,
  configPath: string,
  timeoutMs: number,
  staleMs: number,
): Promise<ConfigLockInfo> {
  const info: ConfigLockInfo = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const body = JSON.stringify(info);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      // On Windows a create/delete race can surface EPERM / EBUSY / EACCES
      // instead of EEXIST; treat all of them as possible contention and let
      // stat decide whether to wait or retry immediately.
      if (
        !isErrno(error, 'EEXIST') &&
        !isErrno(error, 'EPERM') &&
        !isErrno(error, 'EBUSY') &&
        !isErrno(error, 'EACCES')
      ) {
        throw error;
      }

      let mtimeMs: number;
      try {
        mtimeMs = (await stat(lockPath)).mtimeMs;
      } catch (statError) {
        if (!isErrno(statError, 'ENOENT')) throw error;
        // Released between open and stat (possibly Windows delete-pending): back off briefly.
        if (Date.now() >= deadline) {
          throw lockedError(
            configPath,
            `timed out after ${timeoutMs}ms waiting for the config lock`,
          );
        }
        await sleep(retryDelayMs());
        continue;
      }

      if (Date.now() - mtimeMs > staleMs) {
        if (await reclaimStale(lockPath, staleMs)) continue;
      }
      if (Date.now() >= deadline) {
        throw lockedError(configPath, `timed out after ${timeoutMs}ms waiting for the config lock`);
      }
      await sleep(retryDelayMs());
      continue;
    }

    try {
      await handle.writeFile(body, 'utf8');
    } catch (error) {
      await handle.close().catch(() => {});
      // A failed write must not leave an empty "held" lock behind.
      await unlink(lockPath).catch(() => {});
      throw error;
    }
    await handle.close();
    return info;
  }
}

/** Delete the lock only if its token is ours; ignore ENOENT / EPERM and release failures. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  let info: ConfigLockInfo | undefined;
  try {
    info = parseLockInfo(JSON.parse(await readFile(lockPath, 'utf8')));
  } catch {
    // Lock already gone or unreadable: nothing owned to delete.
    return;
  }
  if (info === undefined || info.token !== token) return;
  try {
    await unlink(lockPath);
  } catch {
    // ENOENT / EPERM ignored; the stale TTL reclaims anything left behind.
  }
}

/**
 * Run `fn` while holding the cross-process lock for `configPath`
 * (wrap only the read-modify-write section).
 *
 * @throws MarketplaceError `config_locked` on timeout or nested locking
 */
export async function withConfigLock<T>(
  configPath: string,
  fn: () => T | Promise<T>,
  options: ConfigLockOptions = {},
): Promise<T> {
  const lockPath = path.resolve(`${configPath}.lock`);
  const active = activePaths.getStore();
  if (active?.has(lockPath) === true) {
    // Same async context re-entry: queuing would wait on ourselves.
    throw lockedError(configPath, 'nested lock');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  const previous = chains.get(lockPath) ?? Promise.resolve();
  let releaseChain: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseChain = resolve;
  });
  const tail = previous.then(() => current);
  chains.set(lockPath, tail);

  let info: ConfigLockInfo | undefined;
  try {
    await previous;
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    info = await acquireLock(lockPath, configPath, timeoutMs, staleMs);

    const nextActive = new Set(active ?? []);
    nextActive.add(lockPath);
    return await activePaths.run(nextActive, async () => fn());
  } finally {
    if (info !== undefined) await releaseLock(lockPath, info.token);
    releaseChain();
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  }
}
