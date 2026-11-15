/**
 * 回填段 → 本地事件环（`EventStore.entries`）的合并核心（**纯函数**）。
 *
 * ## 为什么需要这一层
 *
 * 刷新 / 重连时，「此刻的事实」要由三段拼出来：消息投影（`sessions.get`）、磁盘事件
 * （`sessions.events` / `events.list`）、环（`events.subscribe`）。今天只有环这一条接线，
 * 于是 `D \ R`（磁盘有、环已淘汰）那一段没有任何路径进 UI —— 这就是「刷新后这次 run
 * 只剩几条」的结构性缺口（`docs/dev/handoff/replay-gap-findings.md`）。
 *
 * 本文件只回答一个问题：**一段回填事件怎么落进本地 `entries` 而不破坏既有不变量**。
 *
 * ## 三套 seq 空间（必须先解决，不能绕过）
 *
 * - **session 全局**：`sessions/<id>/events.ndjson` 的 `seq`，每会话自增、跨进程重启从
 *   文件尾续号（`session-event-log.ts`）；
 * - **per-run**：run trace 的 `seq`（`events.list`），每个 run 从 1 开始；
 * - **hub 全局**：环 / 实时流的 `seq`，进程内自增、重启归零（`event-buffer.ts`）。
 *
 * 三者**不能比大小**。所以本地条目 seq 用两个固定偏移把它们排进「环带之下的两个负数
 * 带」，`entries` 仍是数值升序 —— `truncateAfter` 的二分、`push` 的单调水位、
 * `EventStore.currentSeq`（重连 `since`）全都不用改：
 *
 * ```
 *   会话日志带            trace 带            环 / 实时带
 *   [-2e9+1 .. -1e9]  |  (-1e9 .. 0)      |  [1 .. +∞)   ← hub seq
 * ```
 *
 * 会话日志在 trace 之前、trace 在环之前，都是**结构性**结论而不是排序偏好：能被环送到
 * 的事件是「最新那一段」，环淘汰的永远是一个连续前缀（FIFO），磁盘日志 append-only 且
 * 每会话连续编号；trace 只可能来自「更早的 run」（当前 run 的事件优先从环/磁盘来）。
 *
 * 已知代价（写清而不是糊过去）：同一个 run 内，trace 带的条目排在会话日志带的条目
 * **之后**，所以 `context.changed` 这类 trace-only 的 notice 会落在该 run 的内容之后，
 * 而不是按时间插在中间。要「跨源严格按时间交错」必须有一条持久全局 seq（见
 * `docs/architecture/session-replay.md` §3「水印是全局单调 seq」这一未解边界）。
 *
 * ## 去重（跨源，**禁用 seq**）
 *
 * 跨源只认内容 id `run_id|type|ts`（`gateway/replay-source.ts#stableEventId`，契约 §8 第
 * 3 条）：三套 seq 之间没有任何映射，同一逻辑事件在三处的数字完全不同。
 * 段内幂等另用一条 ledger：会话日志用 `(run_id, seq)` 复合键，trace 用
 * `(run_id, seq)` —— 它们在**各自 seq 空间内**唯一，用来挡住「同一批事件被回填两次」。
 */
import type { ReplayEvent } from '../gateway/replay-source';
import { stableEventId } from '../gateway/replay-source';
import type { RunEvent } from '../gateway/types';
import type { StoredEvent } from './events';

/**
 * 会话日志带的下界：`storeSeq = sessionSeq - SESSION_LOG_SEQ_OFFSET`，取值
 * `[-2e9+1, -1e9]`（要求 `sessionSeq < 1e9`，超过就拒绝这条并入并计数）。
 */
export const SESSION_LOG_SEQ_OFFSET = 2_000_000_000;

/**
 * trace 带的上界：`storeSeq = rank - TRACE_SEQ_OFFSET`，取值 `(-1e9, 0)`。
 *
 * `rank` 是**单调递增**的计数器（由 `EventStore` 持有并跨次回填续上），而不是「本批
 * 序号」—— 否则第二次回填的 trace 事件会排到第一次的前面（同一 run 内顺序反了）。
 */
export const TRACE_SEQ_OFFSET = 1_000_000_000;

/** 支持的回填段（与 `gateway/replay-source.ts` 的两个来源一一对应）。 */
export type ReplaySegment = 'session-log' | 'trace';

/** 段内身份键（ledger 用；各 seq 空间内唯一，**不跨源比较**）。 */
export function segmentIdentity(segment: ReplaySegment, event: ReplayEvent): string {
  const run = typeof event.run_id === 'string' ? event.run_id : '';
  return `${segment === 'session-log' ? 's' : 't'}\u0000${run}\u0000${event.seq}`;
}

/** 会话日志 seq → 本地负数带；越界（≥ 1e9 / 非整数）返回 `null` = 拒绝并入。 */
export function sessionLogStoreSeq(sessionSeq: number): number | null {
  if (!Number.isInteger(sessionSeq) || sessionSeq < 1) return null;
  if (sessionSeq >= TRACE_SEQ_OFFSET) return null;
  return sessionSeq - SESSION_LOG_SEQ_OFFSET;
}

/** trace 序位 → 本地负数带（`rank >= 1`）。 */
export function traceStoreSeq(rank: number): number {
  return rank - TRACE_SEQ_OFFSET;
}

/** 是否落在「环带」的条目（`push` 收的 hub seq）。 */
export function isHubSeq(seq: number): boolean {
  return seq > 0;
}

/** 事件体 → 渲染侧的 `RunEvent`（缺 `data` 时给空对象，别让 fold 到处判空）。 */
export function toRunEvent(event: ReplayEvent): RunEvent {
  const data = event.data;
  return {
    type: event.type,
    run_id: typeof event.run_id === 'string' ? event.run_id : '',
    ts: event.ts,
    data:
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  };
}

export interface SegmentMergeStats {
  /** 并入条数。 */
  accepted: number;
  /** 因「环 / 已收到的那一份有同一内容 id」而丢掉的条数。 */
  duplicates: number;
  /** 因段内身份已并入过而跳过的条数（跨次回填幂等）。 */
  alreadyMerged: number;
  /** 因 seq 越界而拒绝的条数。 */
  outOfRange: number;
  /**
   * 因 `ts` 晚于「环里最新的那一条」而**押后**的条数。
   *
   * 为什么不直接并进来：`run-journal` 是「先落盘后广播」，所以磁盘尾部可能比客户端已经
   * 收到的那一帧更新（在飞）。这些事件马上会由实时流送到；硬并进磁盘带会把「更晚的事件」
   * 排到「更早的」之前（同 run 内的段序 / 工具卡配对都会错）。押后不是丢 —— 它们会在
   * 实时帧到达时正常入环；万一那一帧丢了，下一次回填时它们已经不再「更新」，自然补上。
   */
  deferred: number;
}

export interface SegmentMergeInput {
  segment: ReplaySegment;
  /** 回填段（顺序不限；内部会按各自 seq 空间排序）。 */
  events: readonly ReplayEvent[];
  /** 本地已有条目（环 + live + 之前并入的段）。 */
  existing: readonly StoredEvent[];
  /** 已并入过的段内身份键（`EventStore` 持有的 ledger；缺省 = 空）。 */
  merged?: ReadonlySet<string>;
  /** 并入条目的会话归属（磁盘事件不透出 `session_id`，只能由调用方盖上）。 */
  sessionId?: string;
  /**
   * 「环里最新的 ts」：晚于它的事件一律押后（见 `SegmentMergeStats#deferred`）。
   * 缺省 `Infinity` = 不押后（本地还没有任何环事件时就是这种情形）。
   */
  tsCeiling?: number;
  /** trace 带的起始 rank（缺省 1）。只对 `segment: 'trace'` 有意义。 */
  traceRankStart?: number;
}

export interface SegmentMergePlan {
  /** 要并入的条目，按 `seq` 升序。 */
  entries: StoredEvent[];
  /** 本次「看过」的全部段内身份键（含被判重复 / 押后的），追加进 ledger 后跨次幂等。 */
  identities: string[];
  /** 押后事件的身份键**不进** ledger：它们的正确落点是实时帧或下一次回填。 */
  stats: SegmentMergeStats;
  /** trace 带用掉了多少 rank（下次从 `traceRankStart + traceRankUsed` 继续）。 */
  traceRankUsed: number;
}

/** 「环里最新的一条」的 `ts`（本地还没有 hub 事件时 = `Infinity` = 不押后）。 */
export function hubTsCeiling(entries: readonly StoredEvent[]): number {
  let ceiling = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (!isHubSeq(entry.seq)) continue;
    if (entry.event.ts > ceiling) ceiling = entry.event.ts;
  }
  return ceiling === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : ceiling;
}

/**
 * 纯函数：把一段回填折成「要并进 `EventStore.entries` 的增量」。
 *
 * 不变量（离线断言见 `scripts/check-replay-apply.ts`）：
 * 1. **只增不改**：返回的是**新增**条目，绝不表达删除 —— 调用方没有「整段 replace」这种
 *    动作可用（「禁止整段 replace」在这里是结构性的，不是靠纪律）。
 * 2. **幂等**：同一段重复喂进来，`identities` 命中 ledger 后 `entries` 为空。
 * 3. **跨源去重**：内容 id 已在 `existing` 里的事件不会再产出一份（`duplicates`）。
 * 4. **顺序确定性**：会话日志按 session seq、trace 按 `(ts, run_id, seq)`；与「先喂哪一段」
 *    无关（各带互不重叠）。
 */
export function planSegmentMerge(input: SegmentMergeInput): SegmentMergePlan {
  const stats: SegmentMergeStats = {
    accepted: 0,
    duplicates: 0,
    alreadyMerged: 0,
    outOfRange: 0,
    deferred: 0,
  };
  const identities: string[] = [];
  const entries: StoredEvent[] = [];
  const merged = input.merged;
  const ceiling = input.tsCeiling ?? Number.POSITIVE_INFINITY;

  // 跨源索引只覆盖「本段出现过的类型」：既不为无关类型算内容 id，也让代价与「这段多大」
  // 成正比，而不是与「环里有多少条」成正比。
  const wantedTypes = new Set(input.events.map((event) => event.type));
  const existingIds = new Set<string>();
  for (const entry of input.existing) {
    if (!wantedTypes.has(entry.event.type)) continue;
    existingIds.add(
      stableEventId({
        seq: entry.seq,
        type: entry.event.type,
        ts: entry.event.ts,
        run_id: entry.event.run_id,
      }),
    );
  }

  // 排序：会话日志按 session seq；trace 按时间（trace 的 seq 是 per-run 的，跨 run 不可比）。
  const ordered = [...input.events].sort((left, right) => {
    if (input.segment === 'session-log') return left.seq - right.seq;
    if (left.ts !== right.ts) return left.ts - right.ts;
    const leftRun = left.run_id ?? '';
    const rightRun = right.run_id ?? '';
    if (leftRun !== rightRun) return leftRun < rightRun ? -1 : 1;
    return left.seq - right.seq;
  });

  let rank = input.traceRankStart ?? 1;
  const batchIds = new Set<string>();
  for (const event of ordered) {
    const identity = segmentIdentity(input.segment, event);
    const seq =
      input.segment === 'session-log' ? sessionLogStoreSeq(event.seq) : traceStoreSeq(rank);
    if (seq === null) {
      stats.outOfRange += 1;
      identities.push(identity);
      continue;
    }
    // 押后的事件**不进 ledger**：它们还不是「已并入」，下一次回填必须还能再考虑一次。
    if (event.ts > ceiling) {
      stats.deferred += 1;
      continue;
    }
    identities.push(identity);
    if (merged?.has(identity) === true) {
      stats.alreadyMerged += 1;
      continue;
    }
    const contentId = stableEventId(event);
    if (existingIds.has(contentId) || batchIds.has(contentId)) {
      stats.duplicates += 1;
      continue;
    }
    batchIds.add(contentId);
    const owner = input.sessionId;
    entries.push({
      event: toRunEvent(event),
      seq,
      ...(owner !== undefined && owner !== '' ? { sessionId: owner } : {}),
    });
    stats.accepted += 1;
    if (input.segment === 'trace') rank += 1;
  }
  entries.sort((left, right) => left.seq - right.seq);
  return {
    entries,
    identities,
    stats,
    traceRankUsed: rank - (input.traceRankStart ?? 1),
  };
}
