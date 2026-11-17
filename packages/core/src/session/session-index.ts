/**
 * 会话索引（`sessions/<id>/index.json`）的**唯一读写口径**。
 *
 * 为什么单独一个模块（0.54 stop-write）：这份索引有**两个**持有者，却只能有一份形状：
 *
 * | 持有者 | 用途 |
 * | --- | --- |
 * | `TimelineEventLog`（时间线读口，0.54 起是新会话的唯一持有者） | 写元数据 + 读回 |
 *
 * （0.55 之前还有第二个持有者 `SessionEventLog`，它那份 `events.ndjson` 实现已随旧格式
 * 一起删除，所以表格只剩一行。）
 *
 * 抄一份形状就等于多一个会漂移的口径（`SessionLogIndex` 里的 `messages_cached: true`、
 * 终态才有 `completed_at` 这两条都是**判据**，不是装饰）。所以读/写的实现只有这里一份。
 *
 * 索引**不是事实**：它只是元数据缓存（title / preview / status / 时间戳 / 计数），
 * 丢了可以从事件与时间线重建。
 *
 * @module @vessel-agent/core/session
 */

import { readFile } from 'node:fs/promises';
import { sessionIndexFilePath } from '../tenant/index.js';
import type { SessionIndexPatch } from '../types/event.js';
import { atomicWrite } from './atomic-write.js';

/** 会话索引（`index.json`）；只放元数据，messages 仍是缓存 */
export interface SessionLogIndex {
  v: 1;
  session_id: string;
  title?: string;
  preview?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  started_at?: number;
  /**
   * 终态时刻（additive）：**只在 `status` 是终态时存在**，等于该次终态写入的
   * `updated_at`。`running` 时一律不写（连继承来的旧值也清掉）——「跑着但已经完成于
   * 某刻」是自相矛盾的元数据，比缺字段更容易骗人。
   *
   * 它让「这份索引说会话已经完了」变成**一个字段就能回答**的问题：读侧不必再拿
   * `updated_at` 猜（`updated_at` 在 run 进行中也会前进）。
   */
  completed_at?: number;
  updated_at: number;
  /**
   * **会话事实源的最后 seq**（时间线时代 = `timeline.idx/session.idx` 的 `last_seq`），
   * **不是事件条数**：chunk 也占 seq（长 run 里可以是事实行的几十倍），拿它数条数会少报
   * 一个数量级。旧口径写的是 `events.ndjson` 行数 —— 双写会话里那是**另一个 seq 空间**
   * （实测 4133 vs 195979）。现在**只增不减**：多写者各报各的空间时取最大（见
   * `writeSessionIndex`），少报的被兜住、多报的不会发生。
   */
  event_count: number;
  /** 落盘水位（与 `event_count` 同源同值；「写侧不宣布投影覆盖」，ADR-105 D2） */
  derived_upto_seq: number;
  /** 显式标注：`sessions/<id>.json` 中的 messages 只是投影缓存 */
  messages_cached: true;
}

/** 终态 status（`updated_at` 在这几种状态下可以当 `completed_at` 用）。 */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 读 `index.json`；缺失/损坏返回 null（索引是缓存，可从事件重建计数）。 */
export async function readSessionIndex(
  sessionsDir: string,
  sessionId: string,
  onCorrupt?: (detail: { session_id: string; error: string }) => void,
): Promise<SessionLogIndex | null> {
  const path = sessionIndexFilePath(sessionsDir, sessionId);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(content) as SessionLogIndex;
    if (parsed.v !== 1 || typeof parsed.session_id !== 'string') return null;
    return parsed;
  } catch (error) {
    onCorrupt?.({
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 合并写 `index.json`（atomicWrite + 0600）。写失败向调用方抛出。
 *
 * **终态先落这里**：`status` 是终态时同时写 `completed_at`（= 本次 `updated_at`），
 * 于是「这份索引说会话已经完了」只有一个来源、一个时刻。
 *
 * `status` 回到非终态（下一轮 run 开始）时 `completed_at` **必须消失**，所以它不从
 * `existing` 继承：继承会让「running + 上次的完成时刻」这种自相矛盾的索引活下去。
 *
 * @param patch 调用方的合并意图
 * @param counts 调用方拿到的「已落盘到哪」（缺省字段用它兜底）
 *
 * **两个计数只增不减**（`Math.max`）：`event_count` / `derived_upto_seq` 的唯一口径是「事实源的
 * 最后 seq」，而调用方常常只拿得到**别的 seq 空间**的游标（旧日志行数、会话壳的
 * `derived_upto_seq`、`RunJournal.currentSeq()`）——那些数只会**少报**，取最大就让索引永远
 * 不会被一个外来游标按下去。反过来不会发生：没有任何调用方能报出比事实源更大的 seq。
 */
export async function writeSessionIndex(
  sessionsDir: string,
  sessionId: string,
  patch: SessionIndexPatch,
  counts: { event_count?: number; derived_upto_seq?: number } = {},
  existing?: SessionLogIndex | null,
): Promise<void> {
  const path = sessionIndexFilePath(sessionsDir, sessionId);
  const base = existing === undefined ? await readSessionIndex(sessionsDir, sessionId) : existing;
  const status = patch.status ?? base?.status;
  const updatedAt = patch.updated_at ?? Date.now();
  const persisted = counts.event_count ?? 0;
  const eventCount = Math.max(patch.event_count ?? 0, persisted, base?.event_count ?? 0);
  const derivedUpto = Math.max(
    patch.derived_upto_seq ?? 0,
    counts.derived_upto_seq ?? persisted,
    base?.derived_upto_seq ?? 0,
  );
  const next: SessionLogIndex = {
    v: 1,
    session_id: sessionId,
    ...(base?.title !== undefined ? { title: base.title } : {}),
    ...(base?.preview !== undefined ? { preview: base.preview } : {}),
    ...(base?.status !== undefined ? { status: base.status } : {}),
    ...(base?.started_at !== undefined ? { started_at: base.started_at } : {}),
    updated_at: updatedAt,
    event_count: eventCount,
    derived_upto_seq: derivedUpto,
    messages_cached: true,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.started_at !== undefined ? { started_at: patch.started_at } : {}),
    // 终态才有完成时刻；`running` / 未知状态一律不写（见 SessionLogIndex 注释）。
    ...(status !== undefined && TERMINAL_SESSION_STATUSES.has(status)
      ? { completed_at: updatedAt }
      : {}),
  };
  await atomicWrite(path, JSON.stringify(next, null, 2), { mode: 0o600, ensureDir: true });
}
