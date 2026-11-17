/**
 * 按范围读回被压缩的历史（compaction 的**逆向视图**）
 * @module @vessel-agent/core/session
 *
 * ## 一句话
 *
 * 压缩把「一堆消息」换成「一条摘要」。本模块把那些消息**按索引里的 seq 区间**读回来，
 * 一次一页、有界，返回的是原始消息（不是摘要）—— 于是 compaction 从单向门变成
 * 可逆的视图变换。
 *
 * ## 三条硬约束（任何一条破了都会让「压缩」变成「没压缩」或「丢历史」）
 *
 * 1. **不整份读**：走时间线范围读（`readTimelineRange`：只开窗口里那几个块 + 固定探针），
 *    每次调用有**三条显式上界**（消息条数 / token / 扫过的事件数），不做「顺手把整条会话
 *    读一遍」的降级。范围读不可判时**如实报降级**，不静默少给（0.56 设计 §9 的最坏实现
 *    正是「差几条、零报错」）。
 * 2. **不进请求**：返回值只作为**工具输出**回给模型（受 16k 出口闸），绝不写回窗口 /
 *    系统提示 / 历史。写回就等于取消压缩。
 * 3. **不猜**：索引里没有这一段 ⇒ 说「这段会话没有压缩索引」；区间读不出来 ⇒ 说
 *    「读不出来 + 为什么」，不编内容、不用摘要冒充原文。
 *
 * ## 为什么还要走 `projectMessages`
 *
 * 事件日志里存的是**事件**（`user.message` / `llm.response` / `tool.call.completed`），
 * 不是消息数组。区间读回来的事件必须用**同一个**投影函数折成消息，否则「读回的历史」
 * 与「当时窗口里的历史」不是同一个东西（角色 / tool_calls 配对 / run 身份都会漂）。
 * 这里用原文口径（`applyClearedReplacements: false`）：读回的是当时写下的字节，
 * 不是这一轮请求视图里的占位。
 */

import { RECALL_MAX_MESSAGES, RECALL_MAX_TOKENS } from '../context/compaction-index.js';
import { estimateTokens } from '../context/context-manager.js';
import { sessionDirPath } from '../tenant/index.js';
import { assertSessionFormatSupported } from '../timeline/legacy-format.js';
import {
  readTimelineEvents,
  readTimelineRange,
  TimelineRangeUndecidable,
} from '../timeline/wal.js';
import type { Message } from '../types/provider.js';
import {
  createProjectionCursor,
  extendProjection,
  type ProjectableEvent,
} from './project-messages.js';

/**
 * 一页范围读要几条事件（`readTimelineRange` 的 `limit`）。
 *
 * 为什么是 1000：一次窗口里的绝大多数事件是流式 chunk（它们不产出消息），真实会话里
 * **一条消息要扫 ~50 条事件**（`09f82ac6`：766 条消息跨 40 807 个 seq）。每次范围读还要付一份
 * **固定探针成本**（清单枚举 + 归档三重校验 + 行二分，本机实测 ~250 ms），所以页必须开大：
 * 400 条时代价是「每 8 条消息一次探针」，1000 条把它压到 1/3，而 1000 仍远低于
 * `RANGE_READ_MAX_LIMIT`（10 万），块开窗数只受窗口跨度约束。
 */
export const RECALL_PAGE_EVENTS = 1000;

/**
 * 一次调用最多扫多少条事件（第三条上界）。
 *
 * 存在的理由：区间里可能塞满了不产出消息的事件（重试、流式 chunk、上下文卡）。没有这条
 * 上界时「要 20 条消息」可能变成「扫 20 万条事件」—— 那已经不是有界读。
 * 20_000 × ~200 B/行 ≈ 4 MB 的顺序读，与尾部窗口回扫同量级。
 */
export const RECALL_MAX_SCANNED_EVENTS = 20_000;

/** 能产出 / 修正消息的事件类型（其余一律不参与投影：`context.*` / `llm.request` / chunk）。 */
const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.message',
  'message.injected',
  'llm.response',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  'run.completed',
  'message.compaction',
  'session.rewound',
]);

/** 只修正已有消息、自己不产出消息的事件类型。 */
const MUTATING_EVENT_TYPES: ReadonlySet<string> = new Set(['tool.call.started', 'run.completed']);

/** 一段要读的 seq 区间（闭区间）。 */
export interface RecallRange {
  from_seq: number;
  to_seq: number;
}

/** {@link recallCompactedMessages} 的入参。 */
export interface RecallCompactedInput {
  /** `<dataDir>/sessions` */
  sessionsDir: string;
  sessionId: string;
  /** 要读的区间（来自压缩索引的 `removed_ranges`；多段按升序给） */
  ranges: readonly RecallRange[];
  /** 从「段内第几条消息」开始（0 起，跳过 `offset` 条） */
  offset?: number;
  /** 本页最多返回几条消息（缺省 `RECALL_MAX_MESSAGES`，硬上界同值） */
  limit?: number;
  /**
   * 只保留命中的消息（例如 `query` 子串过滤）。
   *
   * 在**分页之前**应用：`offset` / `limit` 数的是命中条数，不是原始条数。上界仍由
   * `RECALL_MAX_SCANNED_EVENTS` 兜住 —— 过滤不会把「有界读」变成「扫完整条会话」，
   * 扫到上界就停并报 `stopped_by: 'event_cap'`。
   */
  filter?: (message: Message) => boolean;
}

/** 读回的一条消息（带它来自哪条事件 —— 区间与内容的对应关系是可核对的）。 */
export interface RecalledMessage {
  seq?: number;
  message: Message;
}

/** 停下来的原因（**每一个都要如实告诉读方**，不许静默截断）。 */
export type RecallStopReason =
  /** 请求的条数已经给满（后面可能还有） */
  | 'message_cap'
  /** token 上界先到 */
  | 'token_cap'
  /** 扫过的事件数上界先到 */
  | 'event_cap'
  /** 区间读完了（后面没有了） */
  | 'range_end';

/** 降级原因（有值 = 结果可能不完整，读方必须转述）。 */
export type RecallDegraded =
  /** 范围读不可判（窗口覆盖算术没过），**没有**退回整份读 */
  | 'range_read_degraded'
  /** 会话太小（`wal.log` < 1 MiB 且块 < 8），范围读没有意义，整份读一次 */
  | 'small_session'
  /** 0.55 之前的格式，这套文件读不了 */
  | 'legacy_session_unsupported';

/** {@link recallCompactedMessages} 的结果。 */
export interface RecallCompactedResult {
  entries: RecalledMessage[];
  /** 实际生效的偏移 / 上限（调用方给的越界值会被夹紧） */
  offset: number;
  limit: number;
  /** 本页消息估算 token（`estimateTokens` 口径，与出口闸同一个数） */
  tokens: number;
  /** 扫过的事件条数（成本自证） */
  scanned_events: number;
  /** 停在哪（见 {@link RecallStopReason}） */
  stopped_by: RecallStopReason;
  /** 下一页的 offset（`stopped_by === 'range_end'` 时缺省） */
  next_offset?: number;
  /**
   * 下一页更便宜的续读起点（= 本页最后一条消息的 seq + 1）。
   *
   * 为什么要有它：`offset` 的语义是「跳过 N 条命中消息」，读侧**必须从区间头扫起**
   * （事件是存储单位，没有「消息下标」可寻址）。区间里一条消息要扫 ~50 条事件，所以
   * `offset` 翻到后几页时每次都要重扫前 N 条 —— 撞上 `RECALL_MAX_SCANNED_EVENTS` 还会
   * 停在原地（一页都拿不到）。用 `from_seq` 续读就只扫剩下的那一段。
   */
  next_from_seq?: number;
  /** 本页消息跨的事件区间（首条 / 末条的 seq；没有消息时缺省） */
  window?: RecallRange;
  /** 耗时（ms，自证「有界」的另一半） */
  elapsed_ms: number;
  degraded?: RecallDegraded;
  /** 降级的稳定原因码（只用于日志 / 展示） */
  degraded_reason?: string;
}

/** 把入参的 `offset` / `limit` 夹进合法范围（越界不报错，夹紧 + 如实回报）。 */
function clampPage(input: { offset?: number; limit?: number }): { offset: number; limit: number } {
  const rawOffset = typeof input.offset === 'number' ? input.offset : 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const rawLimit = typeof input.limit === 'number' ? input.limit : 0;
  const requested = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 0;
  const limit = requested > 0 ? Math.min(requested, RECALL_MAX_MESSAGES) : RECALL_MAX_MESSAGES;
  return { offset, limit };
}

/** 区间规范化：只留正区间，按 `from_seq` 升序（索引本来就该这样，这里是防御）。 */
function normalizeRanges(ranges: readonly RecallRange[]): RecallRange[] {
  const clean: RecallRange[] = [];
  for (const range of ranges) {
    const from = Math.floor(range.from_seq);
    const to = Math.floor(range.to_seq);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from <= 0 || to < from) continue;
    clean.push({ from_seq: from, to_seq: to });
  }
  return clean.sort((left, right) => left.from_seq - right.from_seq);
}

/**
 * 把一页事件里「会产出消息」的那几类收进 `collected`，返回新增的**消息条数**估算。
 *
 * 为什么不在这里投影：投影是折叠（一次 O(n)），每页折一次会让总成本变成「页数 × 已收条数」。
 * 这里只要一个「够不够」的近似数（`MUTATING_EVENT_TYPES` 不算产出），最终一次性投影。
 */
function collect(records: readonly ProjectableEvent[], collected: ProjectableEvent[]): number {
  let produced = 0;
  for (const record of records) {
    if (!MESSAGE_EVENT_TYPES.has(record.type)) continue;
    collected.push(record);
    if (!MUTATING_EVENT_TYPES.has(record.type)) produced += 1;
  }
  return produced;
}

/**
 * 按区间读回原始消息（有界、分页、可降级但**绝不静默少给**）。
 *
 * 逐区间顺序读，每次向时间线要一页（`RECALL_PAGE_EVENTS`）；攒够 `offset + limit` 条消息
 * 或撞上任一条上界就停。返回的是**原文口径**的消息（占位不参与），顺序与事件顺序一致。
 */
export async function recallCompactedMessages(
  input: RecallCompactedInput,
): Promise<RecallCompactedResult> {
  const startedAt = performance.now();
  const { offset, limit } = clampPage(input);
  const ranges = normalizeRanges(input.ranges);
  const sessionDir = sessionDirPath(input.sessionsDir, input.sessionId);
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const empty = (
    stoppedBy: RecallStopReason,
    extra?: Partial<RecallCompactedResult>,
  ): RecallCompactedResult => ({
    entries: [],
    offset,
    limit,
    tokens: 0,
    scanned_events: 0,
    stopped_by: stoppedBy,
    elapsed_ms: elapsed(),
    ...extra,
  });
  if (ranges.length === 0) return empty('range_end');

  try {
    await assertSessionFormatSupported(sessionDir, input.sessionId);
  } catch {
    return empty('range_end', { degraded: 'legacy_session_unsupported' });
  }

  /** 本页要收的前 `offset + limit` 条消息。 */
  const wanted = offset + limit;
  const collected: ProjectableEvent[] = [];
  let scanned = 0;
  let stoppedBy: RecallStopReason = 'range_end';
  let degraded: RecallDegraded | undefined;
  let degradedReason: string | undefined;
  /**
   * 已收集的「消息条数」估算（够不够一眼就知道要不要再读一页）。
   *
   * 按事件近似而不是每页重投影：宁可**多**收几条（后面对齐时按 `limit` 切掉），
   * 也不能少收 —— 少收就是静默少给。
   */
  let messagesSeen = 0;

  for (const range of ranges) {
    let since = range.from_seq - 1;
    while (since < range.to_seq) {
      const pageLimit = Math.min(RECALL_PAGE_EVENTS, range.to_seq - since);
      let records: readonly ProjectableEvent[];
      try {
        const page = await readTimelineRange(sessionDir, { sinceSeq: since, limit: pageLimit });
        records = page.records as ProjectableEvent[];
      } catch (error) {
        const reason = error instanceof TimelineRangeUndecidable ? error.reason : 'read_failed';
        if (reason === 'blocks_below_threshold') {
          // 小会话：门槛本身给出了上界（< 1 MiB 且块 < 8），整份读一次不算「整份读」。
          degraded = 'small_session';
          degradedReason = reason;
          records = (await readTimelineEvents(sessionDir).catch(() => [])) as ProjectableEvent[];
          scanned += records.length;
          messagesSeen += collect(records, collected);
          stoppedBy = messagesSeen >= wanted ? 'message_cap' : 'range_end';
          break;
        }
        // 不可判：**不**退回整份读（那正是「有界」的反面），如实报降级。
        degraded = 'range_read_degraded';
        degradedReason = reason;
        stoppedBy = messagesSeen > 0 ? 'message_cap' : 'range_end';
        break;
      }
      if (records.length === 0) break;
      scanned += records.length;
      messagesSeen += collect(records, collected);
      const lastSeq = records[records.length - 1]?.seq;
      if (typeof lastSeq !== 'number' || lastSeq <= since) {
        // 范围读承诺 seq 严格前进；不前进只可能是不可判，别在原地打转。
        degraded = 'range_read_degraded';
        degradedReason = 'no_progress';
        stoppedBy = messagesSeen > 0 ? 'message_cap' : 'range_end';
        break;
      }
      since = lastSeq;
      // 有过滤时「够不够」不能按消息条数判（命中的可能一条都不在这一页），
      // 只能扫到区间尾或事件上界 —— 有界靠 `RECALL_MAX_SCANNED_EVENTS`。
      if (input.filter === undefined) {
        if (messagesSeen >= wanted) {
          stoppedBy = 'message_cap';
          break;
        }
      } else if (scanned >= RECALL_MAX_SCANNED_EVENTS) {
        stoppedBy = 'event_cap';
        break;
      }
      if (scanned >= RECALL_MAX_SCANNED_EVENTS) {
        stoppedBy = 'event_cap';
        break;
      }
    }
    if (stoppedBy !== 'range_end') break;
    if (input.filter === undefined && messagesSeen >= wanted) {
      stoppedBy = 'message_cap';
      break;
    }
  }

  // 投影：一次折出这一批事件（原文口径 + 与消息平行的 seq 记录）。
  const cursor = createProjectionCursor({ applyClearedReplacements: false });
  extendProjection(cursor, collected);
  const projected = cursor.messages;
  const projectedSeqs = cursor.messageSeqs;

  const entries: RecalledMessage[] = [];
  let tokens = 0;
  let skipped = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const message = projected[index];
    if (message === undefined) continue;
    if (input.filter !== undefined && !input.filter(message)) continue;
    if (skipped < offset) {
      skipped += 1;
      continue;
    }
    const cost = estimateTokens(message.content ?? '') + 8;
    // token 上界：先到者胜（与出口闸同一个口径 —— 超了就会被闸切尾，那是有损的）。
    if (entries.length > 0 && tokens + cost > RECALL_MAX_TOKENS) {
      stoppedBy = 'token_cap';
      break;
    }
    tokens += cost;
    const seq = projectedSeqs[index];
    entries.push({ ...(typeof seq === 'number' ? { seq } : {}), message });
    if (entries.length >= limit) {
      // 收满一页：若收集阶段本来还有更多消息，就是条数上界；否则区间到头了。
      if (messagesSeen > offset + entries.length && stoppedBy === 'range_end') {
        stoppedBy = 'message_cap';
      }
      break;
    }
  }

  const first = entries[0]?.seq;
  const last = entries[entries.length - 1]?.seq;
  const more =
    stoppedBy === 'message_cap' || stoppedBy === 'token_cap' || stoppedBy === 'event_cap';
  return {
    entries,
    offset,
    limit,
    tokens,
    scanned_events: scanned,
    stopped_by: stoppedBy,
    ...(more ? { next_offset: offset + entries.length } : {}),
    // 续读起点：比 `offset` 便宜得多（不重扫前面的消息），也是唯一能跨过
    // `RECALL_MAX_SCANNED_EVENTS` 继续读的办法。
    ...(more && last !== undefined ? { next_from_seq: last + 1 } : {}),
    ...(first !== undefined && last !== undefined
      ? { window: { from_seq: first, to_seq: last } }
      : {}),
    elapsed_ms: elapsed(),
    ...(degraded !== undefined ? { degraded } : {}),
    ...(degradedReason !== undefined ? { degraded_reason: degradedReason } : {}),
  };
}
