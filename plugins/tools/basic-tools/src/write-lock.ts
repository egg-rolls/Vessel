/**
 * @vessel-agent/basic-tools - 工作区写锁（蜂群 Phase 1 第三重保险）
 * @module @vessel-agent/basic-tools/write-lock
 *
 * edit/write 的写临界区（读→比对→写）前持有一把**全工作区单锁**，临界区后释放。
 * 锁文件 `<baseCwd>/.vessel/write.lock`；跨进程 / 跨 engine / 跨 node 同机有效。
 * 锁的是**写动作**（毫秒级临界区），不是任务 / 文件所有权——无分钟级 checkout，
 * 不重演按文件分工的堵塞（研究草案 §3.6）。
 *
 * 原语跟随 `src/data-lock.ts` 的已验证模式（宪法 10 §7 第二调用点复制，第三次再收）：
 * `link(tmp, 目标)` 原子发布（不支持硬链接的文件系统回退 `open('wx')`）+ owner JSON +
 * stale 回收（pid ESRCH / mtime 宽限 / 跨主机 24h）+ `.reclaim` 守卫（删除前重读 owner）。
 * 与 data-lock 的两点差异，都因为临界区是毫秒级：
 * - 存活 pid 持有超过 {@link WRITE_LOCK_STALE_MS} 视为 hung，可回收（data-lock 的长操作
 *   同主机存活 pid 永不过期；这里持有 30s 只可能是进程卡死在临界区内）。
 * - 争用用短轮询等待（{@link WRITE_LOCK_WAIT_MS} 上限）而非立即失败——写节奏秒级、
 *   临界区毫秒级，等待几乎总是立即成功；超时折稳定错误（run 继续）。
 *
 * **覆盖语义（诚实标注）**：合作式协议——约束一切经 edit/write 的写入者；
 * bash / IDE / git 等非合作写入者不受此锁约束（Windows 目标文件强制锁加固另批）。
 * 这不是沙箱，不解析 bash 命令的文件写（ADR-055/083）。
 *
 * **锁权威边界 = baseCwd（工作区代理）**：共享同一 baseCwd 的写入者见同一把锁；
 * 成员 cwd 不同则锁不同（Phase 1 已知局限，见研究草案 §3.6）。
 * 基础设施失败（目录不可写等）**fail-closed**：折稳定错误，不静默降级为无锁写。
 */

import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** 争用等待上限（毫秒）；超时折稳定错误 */
export const WRITE_LOCK_WAIT_MS = 10_000;

/** 争用轮询间隔（毫秒） */
const WRITE_LOCK_POLL_MS = 25;

/** 存活 pid 持有超过此时长视为 hung（临界区毫秒级，30s 只可能是卡死） */
export const WRITE_LOCK_STALE_MS = 30_000;

/** 不可解析 / 空锁文件的 mtime 宽限（窗口内视为「仍在写入」，不回收） */
const WRITE_LOCK_UNPARSEABLE_GRACE_MS = 5_000;

/** 回收守卫超过此时长视为 stale（守卫无数据，清理安全） */
const WRITE_LOCK_RECLAIM_GUARD_STALE_MS = 10_000;

/** 跨主机锁超过此时长即视为 stale（同主机存活 pid 走 STALE_MS 判 hung） */
const WRITE_LOCK_CROSS_HOST_STALE_MS = 24 * 60 * 60 * 1000;

/** 锁文件 owner（nonce 区分同 pid 同毫秒的两次持有，释放时全等才删） */
interface WriteLockOwner {
  pid: number;
  started_at: number;
  host: string;
  nonce: string;
}

/** 写锁获取失败（争用超时 / 基础设施失败 / 取消）；message 即回给模型的稳定错误文本 */
export class WriteLockError extends Error {
  readonly code = 'write_locked' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WriteLockError';
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function isOwner(value: unknown): value is WriteLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.started_at === 'number' &&
    Number.isFinite(record.started_at) &&
    typeof record.host === 'string' &&
    typeof record.nonce === 'string'
  );
}

function sameOwner(a: WriteLockOwner, b: WriteLockOwner): boolean {
  return (
    a.pid === b.pid && a.started_at === b.started_at && a.host === b.host && a.nonce === b.nonce
  );
}

/** pid 存活判定：ESRCH = 不存在；EPERM / 其他 = 保守视为存活（data-lock 同口径） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

async function readOwner(lockPath: string): Promise<WriteLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf-8'));
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 文件是否已消失（ENOENT）；其它 stat 错误保守视为「存在」 */
async function isGone(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return false;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

/**
 * stale 判定：
 * - 不可解析 / 空文件：mtime 宽限（宽限内视为仍在写入）；文件消失 = 可重建。
 * - 可解析：pid 不存在 → stale；跨主机且 started_at 超 24h → stale；
 *   持有超 STALE_MS（含同主机存活 pid）→ hung，stale。
 */
async function ownerIsStale(lockPath: string, owner: WriteLockOwner | undefined): Promise<boolean> {
  const now = Date.now();
  if (owner === undefined) {
    try {
      const stats = await stat(lockPath);
      return now - stats.mtimeMs > WRITE_LOCK_UNPARSEABLE_GRACE_MS;
    } catch (error) {
      return isErrno(error, 'ENOENT');
    }
  }
  if (!pidAlive(owner.pid)) return true;
  if (owner.host !== os.hostname()) {
    return now - owner.started_at > WRITE_LOCK_CROSS_HOST_STALE_MS;
  }
  return now - owner.started_at > WRITE_LOCK_STALE_MS;
}

/**
 * 原子发布锁内容：完整写入同目录临时文件后 `link` 到锁路径（data-lock publishLock 同形）。
 * `link` 不可用（非同一文件系统 / 不支持硬链接）时回退 `open('wx')` + write。
 * EEXIST 原样抛出（调用方据此走争用路径）。
 */
async function publishLock(lockPath: string, content: string): Promise<void> {
  const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    try {
      await link(tmpPath, lockPath);
      return;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) throw error;
      // 回退：文件系统不支持硬链接。
    }
  } finally {
    await unlink(tmpPath).catch(() => {
      // 临时文件可能未创建 / 已 link 走
    });
  }

  const handle = await open(lockPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf-8');
  } catch (error) {
    await handle.close();
    await unlink(lockPath).catch(() => {
      // best-effort
    });
    throw error;
  }
  await handle.close();
}

type ReclaimOutcome = 'reclaimed' | 'not_stale' | 'busy';

/**
 * 在 `.reclaim` 守卫内回收 stale 锁（data-lock reclaimStaleLock 同形）：
 * 拿到守卫后**重新读取 owner**，仍 stale 且与预期身份全等才 unlink——
 * 防止「基于旧读取删掉别人刚发布的新锁」造成双持有。
 */
async function reclaimStale(
  lockPath: string,
  expected: WriteLockOwner | undefined,
): Promise<ReclaimOutcome> {
  const guardPath = `${lockPath}.reclaim`;
  let guard: Awaited<ReturnType<typeof open>> | undefined;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) return 'busy';
    // 另一个回收者正在工作：守卫新鲜则让路；超过阈值则清理后重试一次。
    try {
      const stats = await stat(guardPath);
      if (Date.now() - stats.mtimeMs <= WRITE_LOCK_RECLAIM_GUARD_STALE_MS) return 'busy';
    } catch {
      return 'busy';
    }
    await unlink(guardPath).catch(() => {
      // best-effort
    });
    try {
      guard = await open(guardPath, 'wx');
    } catch {
      return 'busy';
    }
  }

  try {
    const current = await readOwner(lockPath);
    if (current === undefined && expected === undefined) {
      // 不可解析锁：守卫内再判一次 mtime 宽限
      if (!(await ownerIsStale(lockPath, undefined))) return 'not_stale';
    } else if (current === undefined || expected === undefined || !sameOwner(current, expected)) {
      // 身份已换（别人回收后发布了新锁）或一方消失：不动。
      return 'not_stale';
    } else if (!(await ownerIsStale(lockPath, current))) {
      return 'not_stale';
    }
    await unlink(lockPath).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
    return 'reclaimed';
  } catch {
    return 'busy';
  } finally {
    if (guard !== undefined) {
      await guard.close().catch(() => {
        // best-effort
      });
      await unlink(guardPath).catch(() => {
        // 守卫本身是空文件，删除失败无需处理
      });
    }
  }
}

/** 已获取的写锁；release 仅当 owner 全等时删除（同进程重新加锁时旧 handle 不得删新锁） */
export class WriteLock {
  private readonly lockPath: string;
  private readonly owner: WriteLockOwner;
  private released = false;

  constructor(lockPath: string, owner: WriteLockOwner) {
    this.lockPath = lockPath;
    this.owner = owner;
  }

  /** 释放锁；best-effort（崩溃残留由 stale 协议回收，无需 exit 钩子） */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const current = await readOwner(this.lockPath);
      if (current !== undefined && sameOwner(current, this.owner)) {
        await unlink(this.lockPath);
      }
    } catch {
      // best-effort：锁文件可能已被外部清理
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 获取工作区写锁（edit/write 写临界区前调用）。
 * 争用短轮询等待至 {@link WRITE_LOCK_WAIT_MS}；stale 锁按 data-lock 协议回收。
 * @throws WriteLockError 争用超时 / 基础设施失败 / signal 取消（message 即稳定错误文本）
 */
export async function acquireWriteLock(baseCwd: string, signal?: AbortSignal): Promise<WriteLock> {
  const dir = path.join(baseCwd, '.vessel');
  const lockPath = path.join(dir, 'write.lock');
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new WriteLockError(
      `错误：无法创建写入锁目录 ${dir}：${String(error)}。写入锁 fail-closed，请确认工作目录可写后重试。`,
    );
  }

  const owner: WriteLockOwner = {
    pid: process.pid,
    started_at: Date.now(),
    host: os.hostname(),
    nonce: randomUUID(),
  };
  const content = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + WRITE_LOCK_WAIT_MS;

  for (;;) {
    if (signal?.aborted) throw new WriteLockError('错误：写入锁等待已取消');
    try {
      await publishLock(lockPath, content);
      return new WriteLock(lockPath, owner);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw new WriteLockError(`错误：写入锁获取失败：${String(error)}`);
      }
    }

    const current = await readOwner(lockPath);
    if (await ownerIsStale(lockPath, current)) {
      const outcome = await reclaimStale(lockPath, current);
      if (outcome === 'reclaimed') continue;
      // not_stale / busy → 落到等待
    } else if (await isGone(lockPath)) {
      // 锁刚被释放：立即重试发布，不等轮询
      continue;
    }

    if (Date.now() >= deadline) {
      throw new WriteLockError(
        `错误：写入锁等待超时（${WRITE_LOCK_WAIT_MS}ms，${lockPath} 被其它写入者持有）。请稍后重试。`,
      );
    }
    await sleep(WRITE_LOCK_POLL_MS);
  }
}
