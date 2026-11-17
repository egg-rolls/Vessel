/**
 * `recall` 的输出与控制流（无参列表 / 带参读回）
 * @module @vessel-agent/recall
 *
 * ## 输出格式（与既有工具一致的「单行产出 + 条数 + 尾部说明」）
 *
 * 无参：
 * ```
 * compacted segments: 2 (this session's compaction index)
 * #1 auto 2026-11-14T… 615 messages seq 1..93051 tokens 512000->300000 summary 41 chars sha 9f2c1a0b "…head…"
 * #2 auto …
 * read one: recall compaction_id=<id> [offset] [limit] [query]
 * ```
 *
 * 带 `compaction_id`：
 * ```
 * recall compaction_id=2: showing 1..20 of 766 (seq 66002..125660, 1834 ms-scan events, 12 ms)
 * [1] seq=66002 user | 这是被压缩掉的第一条……
 * [2] seq=66005 assistant | …
 * …
 * next: offset=20 (stopped_by=message_cap)
 * ```
 *
 * 一条消息一行：换行折成 `\n`（读回是**顺序阅读**，折行才能一屏读完），单条正文截到
 * `MAX_MESSAGE_CHARS`（超长工具结果只留头尾，并在该行标注长度 —— 不然一条 400 KB 的
 * 输出会把整页吃掉）。
 */

import {
  type CompactionIndexEntry,
  RECALL_MAX_MESSAGES,
  recallCompactedMessages,
  type ToolContext,
} from '@vessel-agent/core';

/**
 * 单条消息在输出里最多占多少字符。
 *
 * 4000 ≈ 1–2k token：够一条正常工具结果 / 一段正文完整读完，又不至于让一条 400 KB 的
 * 巨型输出把整页预算吃掉（那 400 KB 读回来对模型没有额外价值，行内会标出原长）。
 */
export const MAX_MESSAGE_CHARS = 4000;

/** 单页请求的入参（工具 handler 已校验过类型，这里只做语义校验）。 */
export interface RecallArgs {
  compaction_id?: number;
  from_seq?: number;
  to_seq?: number;
  offset?: number;
  limit?: number;
  query?: string;
}

/** 把入参读成 `RecallArgs`（认不出的键忽略；`.5` / 负号在这里被夹掉）。 */
export function parseRecallArgs(raw: Record<string, unknown>): RecallArgs | string {
  const num = (key: string): number | undefined | string => {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `recall: ${key} must be a finite number`;
    }
    return value;
  };
  const compactionId = num('compaction_id');
  if (typeof compactionId === 'string') return compactionId;
  const fromSeq = num('from_seq');
  if (typeof fromSeq === 'string') return fromSeq;
  const toSeq = num('to_seq');
  if (typeof toSeq === 'string') return toSeq;
  const offset = num('offset');
  if (typeof offset === 'string') return offset;
  const limit = num('limit');
  if (typeof limit === 'string') return limit;
  const query = typeof raw.query === 'string' && raw.query !== '' ? raw.query : undefined;
  return {
    ...(compactionId !== undefined ? { compaction_id: Math.floor(compactionId) } : {}),
    ...(fromSeq !== undefined ? { from_seq: Math.floor(fromSeq) } : {}),
    ...(toSeq !== undefined ? { to_seq: Math.floor(toSeq) } : {}),
    ...(offset !== undefined ? { offset: Math.max(0, Math.floor(offset)) } : {}),
    ...(limit !== undefined ? { limit: Math.max(1, Math.floor(limit)) } : {}),
    ...(query !== undefined ? { query } : {}),
  };
}

/** {@link recallIndexList} 的入参。 */
export interface RecallIndexListInput {
  sessionsDir: string;
  sessionId: string;
  index: readonly CompactionIndexEntry[];
  args: RecallArgs;
}

/**
 * 工具主逻辑：无参列段，有参读回。
 *
 * 两件事都在这里收口（而不是在 handler 里）是为了让「读回」可以被驱动脚本 / 探针直接调用，
 * 不必经过 tool pipeline。
 */
export async function recallIndexList(input: RecallIndexListInput): Promise<string> {
  const { args, index } = input;
  const wanted = resolveRange(input);
  if (typeof wanted === 'string') return wanted;

  if (wanted === undefined) {
    // 无参：只列段（这正是「让模型自查有什么可读」的入口）。
    return formatIndexList(index, input.sessionId);
  }

  const query = args.query;
  const result = await recallCompactedMessages({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    ranges: wanted.ranges,
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(query !== undefined
      ? {
          filter: (message: { content?: string }) =>
            (message.content ?? '').toLowerCase().includes(query.toLowerCase()),
        }
      : {}),
  });
  return formatRecallPage({ label: wanted.label, index, result, query });
}

/** 解析「读哪一段」：`compaction_id` 优先，其次裸区间；两者都没有 ⇒ `undefined`（列段）。 */
function resolveRange(
  input: RecallIndexListInput,
): { ranges: Array<{ from_seq: number; to_seq: number }>; label: string } | undefined | string {
  const { args, index } = input;
  if (args.compaction_id !== undefined) {
    const entry = index.find((item) => item.compaction_id === args.compaction_id);
    if (entry === undefined) {
      const known = index.map((item) => item.compaction_id).join(', ');
      return index.length === 0
        ? noIndexText(input.sessionId)
        : `recall: no compaction_id=${String(args.compaction_id)} in this session (known: ${known})`;
    }
    return {
      ranges: clipRanges(entry.removed_ranges, args.from_seq, args.to_seq),
      label:
        args.from_seq === undefined && args.to_seq === undefined
          ? `compaction_id=${String(entry.compaction_id)}`
          : `compaction_id=${String(entry.compaction_id)} seq ${String(args.from_seq ?? 'start')}..${String(args.to_seq ?? 'end')}`,
    };
  }
  if (args.from_seq !== undefined || args.to_seq !== undefined) {
    const from = args.from_seq ?? 1;
    const to = args.to_seq ?? from;
    if (to < from) return 'recall: to_seq must be >= from_seq';
    return {
      ranges: [{ from_seq: from, to_seq: to }],
      label: `seq ${String(from)}..${String(to)}`,
    };
  }
  return undefined;
}

/**
 * 把一段索引区间夹到 `[from, to]`（两者都可缺省）。
 *
 * 为什么允许「`compaction_id` + `from_seq`」：分页的便宜做法是接着上一页最后一条消息的
 * seq 继续（`next_from_seq`），而这一步必须**留在这一段里** —— 不然一次翻页会读到下一段
 * 压缩的内容，`of N` 的条数就对不上了。
 */
function clipRanges(
  ranges: readonly { from_seq: number; to_seq: number }[],
  from?: number,
  to?: number,
): Array<{ from_seq: number; to_seq: number }> {
  if (from === undefined && to === undefined) return [...ranges];
  const clipped: Array<{ from_seq: number; to_seq: number }> = [];
  for (const range of ranges) {
    const start = Math.max(range.from_seq, from ?? range.from_seq);
    const end = Math.min(range.to_seq, to ?? range.to_seq);
    if (end >= start) clipped.push({ from_seq: start, to_seq: end });
  }
  return clipped;
}

/** 「这条会话没有压缩索引」的原文（三个可能的原因都写清楚，不猜是哪一个）。 */
function noIndexText(sessionId: string): string {
  return [
    `recall: this session has no compaction index (session ${sessionId}).`,
    'Reasons: it was never compacted, or the compaction happened before 0.56 (the index is written at compaction time).',
    'Older sessions can be backfilled from the event log with deriveCompactionIndex(); nothing is invented here.',
  ].join('\n');
}

/** 无参输出：段列表（每段一行，末尾一行说明怎么读）。 */
export function formatIndexList(index: readonly CompactionIndexEntry[], sessionId: string): string {
  if (index.length === 0) return noIndexText(sessionId);
  const lines: string[] = [
    `compacted segments: ${String(index.length)} (this session's compaction index)`,
  ];
  for (const entry of index) {
    lines.push(
      [
        `#${String(entry.compaction_id)}`,
        entry.reason,
        new Date(entry.at).toISOString(),
        `${String(entry.removed)} messages`,
        rangesSummary(entry),
        tokensSummary(entry),
        `summary ${String(entry.replaced_by.summary_chars)} chars sha ${entry.replaced_by.summary_sha8}`,
        `"${entry.summary_head}"`,
      ].join(' '),
    );
  }
  lines.push('read one: recall compaction_id=<id> [offset] [limit] [query]');
  return lines.join('\n');
}

/** 区间摘要：单段给 `seq a..b`，多段给首尾 + 段数（明细在 `recall` 的分页输出里）。 */
function rangesSummary(entry: CompactionIndexEntry): string {
  const ranges = entry.removed_ranges;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const unmapped =
    entry.unmapped_messages > 0 ? ` (${String(entry.unmapped_messages)} unmapped)` : '';
  if (first === undefined || last === undefined) return `seq n/a${unmapped}`;
  if (ranges.length === 1)
    return `seq ${String(first.from_seq)}..${String(last.to_seq)}${unmapped}`;
  return `seq ${String(first.from_seq)}..${String(last.to_seq)} in ${String(ranges.length)} ranges${unmapped}`;
}

/** 体积摘要：`tokens 0->0` 表示老事件没有快照（0 = 未知，不是「零 token」）。 */
function tokensSummary(entry: CompactionIndexEntry): string {
  if (entry.tokens_before === 0 && entry.tokens_after === 0) return 'tokens n/a';
  return `tokens ${String(entry.tokens_before)}->${String(entry.tokens_after)}`;
}

/** {@link formatRecallPage} 的入参。 */
export interface FormatRecallPageInput {
  label: string;
  index: readonly CompactionIndexEntry[];
  result: Awaited<ReturnType<typeof recallCompactedMessages>>;
  query?: string;
}

/** 带参输出：头（条数 / 区间 / 成本）+ 每消息一行 + 尾（怎么翻页 / 降级说明）。 */
export function formatRecallPage(input: FormatRecallPageInput): string {
  const { result, label, index, query } = input;
  const entry = index.find((item) => `compaction_id=${String(item.compaction_id)}` === label);
  const total = entry !== undefined ? String(entry.removed) : '?';
  const shown =
    result.entries.length === 0
      ? `0 messages`
      : `${String(result.offset + 1)}..${String(result.offset + result.entries.length)} of ${total}`;
  const window =
    result.window === undefined
      ? ''
      : `, seq ${String(result.window.from_seq)}..${String(result.window.to_seq)}`;
  const queryText = query === undefined ? '' : `, query "${query}"`;
  const lines: string[] = [
    `recall ${label}: ${shown}${window}${queryText} (scanned ${String(result.scanned_events)} events, ${String(result.tokens)} tokens, ${String(result.elapsed_ms)} ms)`,
  ];
  if (result.entries.length === 0) {
    lines.push(
      query === undefined
        ? 'no messages in this segment/range (the range may hold only non-message events)'
        : `no message in this range matched query "${query}"`,
    );
  }
  for (let index2 = 0; index2 < result.entries.length; index2 += 1) {
    const entry2 = result.entries[index2];
    if (entry2 === undefined) continue;
    const message = entry2.message;
    const seq = entry2.seq === undefined ? 'seq=?' : `seq=${String(entry2.seq)}`;
    const who =
      message.role === 'assistant' && message.tool_calls !== undefined
        ? `assistant(tool_calls: ${message.tool_calls.map((call) => call.function.name).join(',')})`
        : message.role;
    lines.push(
      `[${String(result.offset + index2 + 1)}] ${seq} ${who} | ${oneLine(message.content)}`,
    );
  }
  if (result.next_offset !== undefined) {
    const cheaper =
      result.next_from_seq === undefined ? '' : ` or from_seq=${String(result.next_from_seq)}`;
    lines.push(
      `next: offset=${String(result.next_offset)}${cheaper} (stopped_by=${result.stopped_by})`,
    );
  } else {
    lines.push(`end of range (stopped_by=${result.stopped_by})`);
  }
  if (result.degraded !== undefined) {
    lines.push(
      `degraded: ${result.degraded}${result.degraded_reason === undefined ? '' : ` (${result.degraded_reason})`} — this page may be incomplete`,
    );
  }
  return lines.join('\n');
}

/** 一条消息折成一行（换行 → `\n`，超长截断并标注原长）。 */
function oneLine(content: string): string {
  const flattened = content.replace(/\r?\n/g, '\\n');
  if (flattened.length <= MAX_MESSAGE_CHARS) return flattened;
  const head = flattened.slice(0, MAX_MESSAGE_CHARS);
  return `${head}… [truncated, ${String(flattened.length)} chars total]`;
}

/** 页大小上限（给文档与探针一个可读的符号）。 */
export const RECALL_PAGE_LIMIT = RECALL_MAX_MESSAGES;

/** 未使用的占位以免 `ToolContext` 导入被判死代码（handler 用它取 session_id）。 */
export type RecallToolContext = ToolContext;
