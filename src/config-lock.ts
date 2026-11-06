/**
 * `config.yaml` 跨进程写锁（CONTRACT-0.47 §1–§2）。
 *
 * 主机与插件各有一份逐字一致的实现：锁文件 `${configPath}.lock`，
 * `open(..., 'wx', 0o600)` 原子创建，内容 `{ token, pid, acquiredAt }`。
 * 持锁超过 `staleMs`（默认 15s）视为进程崩溃遗留，可被接管；等待超过
 * `timeoutMs`（默认 5s）抛 `config_locked`。
 *
 * 同进程的并发写者按 `path.resolve(lockPath)` 串行（promise 链），避免互相
 * 抢文件锁；同一异步上下文内递归进入同一路径则直接抛 `config_locked: nested lock`，
 * 不排队等成死锁。包裹点只应覆盖「读 → 改 → 写」，不得嵌套。
 *
 * @module vessel/config-lock
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';

/** 等待锁的默认上限 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** 锁文件超过该时长视为 stale（持有进程可能已崩溃） */
const DEFAULT_STALE_MS = 15_000;

/** stale 锁的 unlink 在 Windows 上遇 EPERM / EBUSY 的重试次数 */
const STALE_UNLINK_RETRIES = 3;

/** stale 接管守卫后缀：`${lockPath}.reclaim`，串行化多个接管者 */
const RECLAIM_SUFFIX = '.reclaim';

/** 接管守卫自身的 stale TTL（守卫只做几次文件操作，窗口极短） */
const RECLAIM_STALE_MS = 2_000;

/** 轮询退避：10–25ms */
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 15;

/** `withConfigLock` 选项；仅供探针缩短等待 */
export interface ConfigLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

interface ConfigLockInfo {
  token: string;
  pid: number;
  acquiredAt: string;
}

/** 当前异步上下文正持有的锁路径（用于嵌套检测） */
const activePaths = new AsyncLocalStorage<ReadonlySet<string>>();

/** 同进程按锁路径串行 */
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

function lockedError(configPath: string, detail: string): Error {
  return new Error(`config_locked: ${detail} (${configPath})`);
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
 * 删除 stale 锁；Windows 上 EPERM / EBUSY 短暂重试。
 * @returns 锁文件是否已不存在（删除成功或本就消失）
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
 * 串行化 stale 接管：只有持有 `${lockPath}.reclaim` 的进程才能删除 stale 锁。
 * 否则两个接管者会交错 unlink/create，晚到的 unlink 会删掉对方刚建的新锁，
 * 造成临界区重叠（L-047）。
 *
 * @returns true 表示锁已被清理，调用方可立即重试创建
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
    // 另一个接管者正在工作；只有守卫本身也 stale 时才清理。
    try {
      const guardStaleMs = Math.min(RECLAIM_STALE_MS, staleMs);
      if (Date.now() - (await stat(guardPath)).mtimeMs > guardStaleMs) {
        await unlinkStale(guardPath);
      }
    } catch {
      // 守卫已消失或不可读：下一轮重试。
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
    // 守卫内重读：拿到守卫前锁可能已被别人接管并重建，此时不能再删。
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

/** 仅删除自己 token 的接管守卫；ENOENT / EPERM 忽略。 */
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

/** 创建锁文件并写入持有者信息；EEXIST 时按 stale / timeout 规则重试 */
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
      // Windows 在删除/重建竞态下可能报 EPERM / EBUSY / EACCES 而非 EEXIST；
      // 这些都按“可能已有锁”处理，再以 stat 结果决定是等待还是立即重试。
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
        // 锁在 open 与 stat 之间被释放（可能是 Windows delete-pending）：稍等再试。
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
      // 写入失败不能留下一个空的“已持有”锁。
      await unlink(lockPath).catch(() => {});
      throw error;
    }
    await handle.close();
    return info;
  }
}

/** 仅当锁文件仍由本 token 持有时删除；ENOENT / EPERM 及释放失败均忽略。 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  let info: ConfigLockInfo | undefined;
  try {
    info = parseLockInfo(JSON.parse(await readFile(lockPath, 'utf8')));
  } catch {
    // 锁已不存在或内容不可读：没有可归属本 token 的文件。
    return;
  }
  if (info === undefined || info.token !== token) return;
  try {
    await unlink(lockPath);
  } catch {
    // ENOENT / EPERM 忽略；残留锁由 stale TTL 兜底，不在此处抛错掩盖业务异常。
  }
}

/**
 * 在 `configPath` 的跨进程写锁内执行 `fn`（只应包住「读 → 改 → 写」）。
 *
 * @throws Error `config_locked: ...` 超时、嵌套或锁文件不可用
 */
export async function withConfigLock<T>(
  configPath: string,
  fn: () => T | Promise<T>,
  options: ConfigLockOptions = {},
): Promise<T> {
  const lockPath = path.resolve(`${configPath}.lock`);
  const active = activePaths.getStore();
  if (active?.has(lockPath) === true) {
    // 同一异步上下文再次进入：排队只会等自己，直接失败。
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
    await mkdir(path.dirname(lockPath), { recursive: true });
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
