/**
 * 从事件日志**重建**压缩索引（老会话的 backfill / 索引自愈）
 * @module @vessel-agent/core/session
 *
 * ## 什么时候需要它
 *
 * 索引是 0.56 起在压缩那一刻写的。在这之前发生过的压缩（比如那次移除 766 条的自动压缩）
 * 只有 `context.compacted` / `message.compaction` 两条事件，没有区间 —— 于是按
 * `compaction_id` 读回无从下手。
 *
 * 本模块做的是**一次性重建**：把事件日志折一遍（`projectMessages` 的同一套折叠），
 * 在每条 `message.compaction` 处比对「这条事件吃掉了哪些消息」，用它们的 seq 补出
 * `removed_ranges`。产出的就是运行时会写的那张表（`CompactionIndexEntry`），可原样
 * append 进 `compactions.ndjson`。
 *
 * ## 边界（别把它当热路径）
 *
 * - **整份读**（`readTimelineEvents`）：所以只给离线 backfill / 诊断用，工具路径不许调它。
 *   `recall` 缺索引时**如实说「没有索引」**，而不是现场重建（那是整份读 + 一次全量折叠）。
 * - `tokens_before/after` 记 0：老事件里没有这两个数（它们是 0.56 才进事件载荷的）。
 *   0 = **未知**，不是「零 token」；读侧展示时应写作 `n/a`。
 * - 只重建「事件里有 `message.compaction`」的那些段；同 `compaction_id` 的重建结果
 *   与运行时写的等价（同一份 `buildCompactionIndexEntry`）。
 */

import {
  buildCompactionIndexEntry,
  type CompactionIndexEntry,
} from '../context/compaction-index.js';
import { sessionDirPath } from '../tenant/index.js';
import { readTimelineEvents } from '../timeline/wal.js';
import type { ContextCompactedReason } from '../types/context.js';
import type { SessionEventRecord } from '../types/event.js';
import type { Message } from '../types/provider.js';
import {
  createProjectionCursor,
  extendProjection,
  type ProjectableEvent,
} from './project-messages.js';

/** {@link deriveCompactionIndex} 的入参。 */
export interface DeriveCompactionIndexInput {
  /** `<dataDir>/sessions` */
  sessionsDir: string;
  sessionId: string;
  /** 直接给事件（调用方已经读过一次）时用它，省掉一次整份读 */
  events?: readonly SessionEventRecord[];
}

/** 一次重建的结果（`entries` 可以直接 append 进索引文件）。 */
export interface DeriveCompactionIndexResult {
  entries: CompactionIndexEntry[];
  /** 折过的事件条数（成本自证：这是一次整份读） */
  events_read: number;
  elapsed_ms: number;
  /** 读不出事件（旧格式 / 文件缺失）时的稳定原因码 */
  degraded?: 'legacy_session_unsupported' | 'read_failed' | 'no_events';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * 折一遍日志，按 `message.compaction` 重建每段的区间。
 *
 * 逐事件折叠（而不是整段丢进 `extendProjection`）：只有在「这条压缩事件前后」才有
 * 中间态可对。代价 = O(事件数 × 窗口条数) 的 `Set` 查询，只在 backfill 里跑。
 */
export async function deriveCompactionIndex(
  input: DeriveCompactionIndexInput,
): Promise<DeriveCompactionIndexResult> {
  const startedAt = performance.now();
  let events: readonly ProjectableEvent[];
  if (input.events !== undefined) {
    events = input.events;
  } else {
    try {
      events = (await readTimelineEvents(
        sessionDirPath(input.sessionsDir, input.sessionId),
      )) as ProjectableEvent[];
    } catch {
      return {
        entries: [],
        events_read: 0,
        elapsed_ms: Math.round(performance.now() - startedAt),
        degraded: 'read_failed',
      };
    }
  }
  if (events.length === 0) {
    return {
      entries: [],
      events_read: 0,
      elapsed_ms: Math.round(performance.now() - startedAt),
      degraded: 'no_events',
    };
  }

  const entries: CompactionIndexEntry[] = [];
  // 复用同一套折叠：一次一条事件，压缩事件处取中间态。
  const cursor = createProjectionCursor({ applyClearedReplacements: false });
  let compactionId = 0;

  for (const event of events) {
    if (event.type !== 'message.compaction') {
      extendProjection(cursor, [event]);
      continue;
    }
    const before = [...cursor.messages];
    const beforeSeqs = [...cursor.messageSeqs];
    extendProjection(cursor, [event]);
    // 压缩是「替换」：留在折叠结果里的消息（对象身份）就是没被吃掉的。
    const survivors = new Set<Message>(cursor.messages);
    const removedSeqs: (number | undefined)[] = [];
    for (let index = 0; index < before.length; index += 1) {
      const message = before[index];
      if (message === undefined) continue;
      // 旧摘要被新摘要替掉，但不计入 `removed`（应用侧只数 `toSummarize`）。
      if (message.compaction_summary === true) continue;
      if (survivors.has(message)) continue;
      removedSeqs.push(beforeSeqs[index]);
    }
    const data = isRecord(event.data) ? event.data : {};
    const recordedRemoved = readCount(data.removed);
    // 事件里记的移除数比我们对出来的多 ⇒ 差额是「定位不到」的消息（旧实现可能连
    // 没有消息产出的段一起算）；如实记进 `unmapped_messages`，不改写 `removed`。
    if (recordedRemoved !== undefined && recordedRemoved > removedSeqs.length) {
      const missing = recordedRemoved - removedSeqs.length;
      for (let index = 0; index < missing; index += 1) removedSeqs.push(undefined);
    }
    const summaryMessage = isRecord(data.message) ? data.message : undefined;
    const summary =
      (summaryMessage !== undefined ? readString(summaryMessage.content) : undefined) ??
      readString(data.summary) ??
      '';
    const reasonRaw = readString(data.reason);
    const reason: ContextCompactedReason =
      reasonRaw === 'auto' || reasonRaw === 'overflow' || reasonRaw === 'manual'
        ? reasonRaw
        : 'manual';
    compactionId += 1;
    entries.push(
      buildCompactionIndexEntry({
        // 老会话没有 compaction_id：按事件顺序从 1 编（单调、可区分多段）。
        compaction_id: compactionId,
        at: typeof event.ts === 'number' ? event.ts : Date.now(),
        reason,
        summary,
        removedSeqs,
        // 老事件没有 token 快照：0 = 未知（不是「零 token」）。
        tokens_before: 0,
        tokens_after: 0,
      }),
    );
  }

  return {
    entries,
    events_read: events.length,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
}
