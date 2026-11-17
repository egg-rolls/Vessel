/**
 * 归档锁：把 `archiveNow()` 的「读水位 → 追加段 → 提交 manifest 行」做成**串行**的一段。
 *
 * ## 它挡的是什么（真实现场）
 *
 * 归档的动作是「读盘上已经归档到哪 → 决定这次抄哪一段 → 追加」。读和写之间只要有第二个
 * 写者插进来按它自己的快照抄同一段，`timeline.ndjson` 里同一个 seq 就会出现两次。而
 * append-only 流里「同 seq 出现两次」不是「多一条冗余」，是**读侧整段拒绝**：
 * `apps/web/src/gateway/timeline-protocol.ts#validateTimelineRange` 的第 1 / 第 4 条规则
 * （seq 严格递增、不得重复）不成立 ⇒ 这一段不合并 ⇒ 用户侧表现为「往上加载更早」永久卡住
 * （`merged=0`、`hasEarlier` 恒 true）。
 *
 * 谁可能是第二个写者：另一个进程（CLI / `node` / 第二个 gateway —— 它们都会 `open()` 同一个
 * 会话目录并且都会归档），或者同进程里第二个 `TimelineWriter` 实例。**同一个实例**不需要
 * 这个锁（`enqueue()` 已经串行），但锁本身没有实例状态，所以两种情形一起挡掉。
 *
 * ## 它不是什么
 *
 * - 不是事实写入的锁（`wal.log` / 块的追加仍然只靠「一个会话一个写者」那条纪律）；
 * - 不是数据、不参与任何读侧判据、不需要 fsync（丢了等于没锁，最坏是这一次归档失败）；
 * - 不改变任何落盘格式语义：`timeline.archive.lock` 只是一个**门槛文件**。
 *
 * ## 三条纪律（都为了「宁可这次不归档，也不许写重」）
 *
 * 1. **拿不到就失败**：等 `ARCHIVE_LOCK_WAIT_MS` 还拿不到 ⇒ 抛 `timeline_archive_failed`，
 *    归档退避后再来。**不排队、不抢跑**（抢跑 = 重复段的入口）。
 * 2. **过期才回收**：锁文件 mtime 超过 `ARCHIVE_LOCK_STALE_MS` 视为崩溃遗留，`unlink` 后
 *    重试一次；短时间内连续回收不设循环（有上限，见 {@link withArchiveLock} 的重试次数）。
 * 3. **释放只删自己的**：`finally` 里 unlink（best-effort）。这里没有「别人的锁」可误删：
 *    过期回收只发生在拿不到锁的分支，而那时代码还没有持有权。
 *
 * 上界（第十一条三问）：一次归档最多等 `ARCHIVE_LOCK_WAIT_MS`（2 s）+ 一次过期回收重试；
 * 触发点只有 `archiveNow()`（空间回收，永不落在写路径上）；用户可见的是「空间晚点回收」。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMELINE_LAYOUT, TimelineError } from './types.js';

/** 一次归档最多等锁多久（毫秒）。超过就放弃本次归档（退避后再来）。 */
export const ARCHIVE_LOCK_WAIT_MS = 2_000;

/** 等锁时的轮询间隔（毫秒）。归档本身是几十毫秒量级，20 ms 的粒度足够。 */
export const ARCHIVE_LOCK_POLL_MS = 20;

/**
 * 锁文件超过这个 mtime 视为崩溃遗留（毫秒）。
 *
 * 取 15 s：正常归档（含 4 次重试 + 2 s 退避）远小于它；而它比一次 fsync 卡顿长得多，
 * 所以「慢但活着」的持有者不会被误回收。
 */
export const ARCHIVE_LOCK_STALE_MS = 15_000;

/** 一次拿锁过程里最多做几次「过期回收」（防两个进程互相回收成死循环）。 */
const ARCHIVE_LOCK_RECLAIM_LIMIT = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** 归档锁的路径。 */
export function archiveLockPath(sessionDir: string): string {
  return join(sessionDir, TIMELINE_LAYOUT.archiveLock);
}

/**
 * 在归档锁内跑 `task`；拿不到锁 ⇒ 抛 `timeline_archive_failed`（**不执行 task**）。
 *
 * `task` 抛错时锁照常释放（否则一次读盘失败就能把归档永久堵死）。
 */
export async function withArchiveLock<T>(sessionDir: string, task: () => Promise<T>): Promise<T> {
  const path = archiveLockPath(sessionDir);
  const deadline = Date.now() + ARCHIVE_LOCK_WAIT_MS;
  let reclaims = 0;
  for (;;) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new TimelineError('timeline_archive_failed', 'archive lock create failed', {
          cause: error,
        });
      }
      // 已有锁：可能是活着的持有者，也可能是崩溃遗留。
      const info = await stat(path).catch(() => undefined);
      if (
        info !== undefined &&
        Date.now() - info.mtimeMs > ARCHIVE_LOCK_STALE_MS &&
        reclaims < ARCHIVE_LOCK_RECLAIM_LIMIT
      ) {
        reclaims += 1;
        await unlink(path).catch(() => {});
        continue; // 立刻重试一次（不占等待预算）
      }
      if (Date.now() >= deadline) {
        throw new TimelineError(
          'timeline_archive_failed',
          `archive lock busy (waited ${String(ARCHIVE_LOCK_WAIT_MS)}ms)`,
        );
      }
      await delay(ARCHIVE_LOCK_POLL_MS);
      continue;
    }
    // 拿到锁：**不写内容**（门槛文件），立刻跑事务体。
    try {
      return await task();
    } finally {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
  }
}
