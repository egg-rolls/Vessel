/**
 * 压缩索引：把 compaction 从「不可逆丢信息」变成**可逆的视图变换**
 * @module @vessel-agent/core/context
 *
 * ## 为什么需要这个模块（真实事故）
 *
 * 一次重启后的 compaction 移除 **766** 条消息、只留 1441 字符的摘要，请求体积 −41%。
 * 被替换的 766 条从窗口与 `SessionState.messages` 里消失，运行时**没有任何读回通道** ——
 * 模型永远看不到它们。压缩因此是单向门：一旦判错（比如锚点没转发导致判据按 ×1.15 高报）
 * 就不可恢复。
 *
 * 本模块只做一件事：**在压缩那一刻记下「被替换的是哪些消息」**，让读侧能按 seq 区间把
 * 原文取回来（`session/compaction-recall.ts`）。它不改变压缩的触发条件，也不改变压缩
 * 移除多少 —— 那些是判据的事，这里是记账的事。
 *
 * ## 索引长什么样（一张可回答问题的表）
 *
 * | 问题 | 字段 |
 * | --- | --- |
 * | 这次压缩是第几段（多段压缩怎么区分） | `compaction_id`（同会话单调递增） |
 * | 被替换的是哪些消息、原来在哪 | `removed_ranges[{from_seq,to_seq,messages}]` |
 * | 被**谁**替换了 | `replaced_by{summary_chars,summary_sha8}`（+ `summary_head`） |
 * | 什么时候、为什么 | `at` / `reason` |
 * | 换来的体积 | `tokens_before` / `tokens_after` |
 *
 * `removed_ranges` 是**区间列表**而不是一个区间：被移除的消息在事件日志里可能分成几段
 * （中间夹着没有消息产出的系统事件）。区间只用来定位，不用来计数 —— 条数以 `messages` 为准。
 *
 * ## 三条纪律
 *
 * 1. **只描述事实**：区间、条数、摘要指纹都是可以从日志验证的数，不含推测；
 * 2. **前缀稳定**：{@link formatCompactionStub} 的输出是索引的纯函数，索引一旦落盘就不再变
 *    ⇒ 同一会话连续两次请求里那条 stub 逐字节相同；
 * 3. **不许把内容塞回请求**：索引只有「区间 + 摘要指纹」，正文必须由模型显式读回
 *    （读回是工具输出，受 16k 出口闸约束）。
 */

import { createHash } from 'node:crypto';
import type { ContextCompactedReason } from '../types/context.js';
import type { Message } from '../types/provider.js';

/**
 * 单次读回的消息条数上限（工具出口闸 16k token 之外的第二道上界）。
 *
 * 取 200 的理由与「一页」同口径：它够让模型重建一段连贯对话（一轮问答 + 若干工具结果），
 * 又不至于让一次 `recall` 把整个窗口的预算吃掉。超过就分页（`offset`），不静默少给。
 */
export const RECALL_MAX_MESSAGES = 200;

/**
 * 单次读回的 token 上界。
 *
 * 与工具结果出口闸同值（`runtime/tool-result-gate.ts` 的 `MAX_TOOL_RESULT_TOKENS`）：
 * 闸在读到超限结果时会把**尾部截掉**（头 30% / 尾 70%），对「读回一段历史」这种
 * 顺序阅读是有损的。所以读侧先自己按同一个数收口，宁可多分几页，也不要被闸切一刀。
 */
export const RECALL_MAX_TOKENS = 16_000;

/** stub 的首行前缀（读侧据此认出「这一段是压缩索引」）。 */
export const COMPACTION_STUB_MARK = '[compacted]';

/**
 * 一条 stub 最多列几段压缩。
 *
 * 索引是**累积**的（多段压缩不覆盖历史），但 stub 是每轮请求的固定 token 税。5 段之后
 * 只报总数（模型仍可用无参 `recall` 列出全部）—— 这里省的是正文，不是事实。
 */
export const COMPACTION_STUB_MAX_ENTRIES = 5;

/** 一段被替换的消息在事件日志里的位置。 */
export interface CompactionRange {
  /** 段内第一条消息所来自的事件的 seq */
  from_seq: number;
  /** 段内最后一条消息所来自的事件的 seq */
  to_seq: number;
  /** 段内消息条数（**不是** `to_seq - from_seq + 1`：区间里还有不产出消息的事件） */
  messages: number;
}

/** 被替换成的那个东西（摘要）的指纹。 */
export interface CompactionReplacement {
  /** 摘要正文字符数（不含 stub） */
  summary_chars: number;
  /** 摘要正文的 sha256 前 8 位：同一份摘要可复算、可对账 */
  summary_sha8: string;
}

/**
 * 一次压缩的索引条目（= `context.compacted` 的 `data.compaction`，也是会话壳里的
 * `SessionState.compactions[]` 一项）。
 *
 * 三个落点、一份内容：事件是事实源（可重放），会话壳是缓存（重启后不用扫日志），
 * 会话目录下的 `compactions.ndjson` 是给工具用的物化索引（可从事件重建，永不作证据）。
 */
export interface CompactionIndexEntry {
  /** 同会话单调递增（1 起）；多段压缩据此区分，不覆盖历史 */
  compaction_id: number;
  /** 压缩完成时刻（epoch ms） */
  at: number;
  reason: ContextCompactedReason;
  /** 本次移除的消息条数（= 各 `removed_ranges[].messages` 之和 + `unmapped_messages`） */
  removed: number;
  /** 被替换消息在事件日志里的区间（升序、互不重叠） */
  removed_ranges: CompactionRange[];
  /**
   * 没拿到 seq 映射的被移除消息条数。
   *
   * 什么时候非零：窗口里的消息必须能追到「它是哪条事件产出的」才谈得上按区间读回。
   * 段起点压缩的窗口整个来自事件投影 ⇒ 恒为 0；run 内强制压缩（`forceCompact`）时，
   * 本次 run 新追加的消息还没有落定 seq ⇒ 会记在这里。**如实上报，不猜**。
   */
  unmapped_messages: number;
  replaced_by: CompactionReplacement;
  /** 摘要首行（列表自查用；≤ 120 字符） */
  summary_head: string;
  /** 压缩前窗口的 token 估算（上界口径，与显示同一个数） */
  tokens_before: number;
  /** 压缩后窗口的 token 估算 */
  tokens_after: number;
}

/** {@link buildCompactionIndexEntry} 的入参。 */
export interface BuildCompactionIndexInput {
  compaction_id: number;
  at: number;
  reason: ContextCompactedReason;
  /** 摘要正文（**不含** stub；stub 是索引的消费者，不是索引的输入） */
  summary: string;
  /** 被移除消息各自的事件 seq；`undefined` = 该消息追不到 seq（计入 `unmapped_messages`） */
  removedSeqs: readonly (number | undefined)[];
  tokens_before: number;
  tokens_after: number;
}

/** 摘要首行的最大字符数（列表里一行一条，超长截断不影响可读性）。 */
export const SUMMARY_HEAD_MAX_CHARS = 120;

/**
 * 摘要正文的指纹。
 *
 * `summary_chars` 用 `String.length`（UTF-16 码元）而不是字节数：与 `message.content` 的
 * 长度口径一致，读侧一眼能对上「这条摘要多长」。
 */
export function summaryFingerprint(summary: string): CompactionReplacement & {
  summary_head: string;
} {
  const text = stripCompactionStub(summary);
  return {
    summary_chars: text.length,
    summary_sha8: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8),
    summary_head: firstLine(text),
  };
}

/** 取首行（截断到 {@link SUMMARY_HEAD_MAX_CHARS}）。 */
function firstLine(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    return truncate(text.slice(0, index));
  }
  return truncate(text);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_HEAD_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SUMMARY_HEAD_MAX_CHARS - 1)}…`;
}

/**
 * 相邻两段之间的「空档」不超过这个 seq 跨度就合并成一段。
 *
 * 为什么合并（真机数据）：`09f82ac6` 那次压缩的 766 条消息落在 **40 807** 个 seq 跨度里，
 * 按「seq 严格连续」切出 **607** 段 —— 而每次范围读都要付一份**固定探针成本**
 * （清单枚举 + 三重归档校验 + 行二分，本机 ~250 ms）。607 次探针 = 一次读回 137 秒
 * （实测），完全不可接受；合并之后同一次读回是 1–3 次探针。
 *
 * 为什么合并**不会**多读出错的内容：被移除的消息在事件顺序里是**连续的一段前缀**
 * （压缩永远删最老的），所以两段之间只会有「不产出消息的事件」（chunk / 上下文卡 /
 * 请求日志）。读侧本来就把这些事件过滤掉（`MESSAGE_EVENT_TYPES`），空档白扫但没有副作用。
 */
export const COMPACTION_RANGE_MERGE_GAP = 512;

/**
 * 一条索引最多保留几段区间（0.56）。
 *
 * 超出就合并**最小的那个空档**（贪心，确定性）：区间是给「一次范围读」用的寻址坐标，
 * 8 段以内一次读回只要 8 次探针；再碎下去就变成「为了精确多扫几千次探针」。
 */
export const COMPACTION_MAX_RANGES = 8;

/**
 * 把「被移除消息的 seq 列表」压成**区间**。
 *
 * 三条规则，都是为了「读得回 + 读得起」：
 *
 * 1. 相邻判定先按 `seq === 上一条 + 1` 切初始 run；
 * 2. 空档 ≤ {@link COMPACTION_RANGE_MERGE_GAP} 的 run 合并（把不产出消息的事件一起纳进来，
 *    读侧过滤掉）—— 否则真实会话会切出几百个小段，每次都付一份固定探针成本；
 * 3. 段数超过 {@link COMPACTION_MAX_RANGES} 时反复合并最小空档。
 *
 * `messages` 始终是**命中条数**（不是区间长度）：合并只改寻址坐标，不改事实。
 * `undefined`（追不到 seq 的消息）不产生区间，只累计条数：区间里凭空塞一个号码就是编造。
 */
export function removedRangesFromSeqs(seqs: readonly (number | undefined)[]): {
  ranges: CompactionRange[];
  unmapped: number;
} {
  const runs: CompactionRange[] = [];
  let unmapped = 0;
  let current: CompactionRange | undefined;
  for (const seq of seqs) {
    if (seq === undefined || !Number.isFinite(seq) || seq <= 0) {
      unmapped += 1;
      continue;
    }
    const value = Math.floor(seq);
    if (current !== undefined && value === current.to_seq + 1) {
      current.to_seq = value;
      current.messages += 1;
      continue;
    }
    if (current !== undefined) runs.push(current);
    current = { from_seq: value, to_seq: value, messages: 1 };
  }
  if (current !== undefined) runs.push(current);
  return { ranges: mergeRuns(runs), unmapped };
}

/** 合并 run（规则见 {@link removedRangesFromSeqs} 的 2 / 3）。 */
function mergeRuns(runs: CompactionRange[]): CompactionRange[] {
  let merged: CompactionRange[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      run.from_seq - previous.to_seq - 1 <= COMPACTION_RANGE_MERGE_GAP
    ) {
      previous.to_seq = run.to_seq;
      previous.messages += run.messages;
      continue;
    }
    merged.push({ ...run });
  }
  // 段数收敛：每次合并**最小**的空档（贪心；确定性，同一输入永远同一输出）。
  while (merged.length > COMPACTION_MAX_RANGES) {
    let smallest = 0;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < merged.length; index += 1) {
      const left = merged[index] as CompactionRange;
      const right = merged[index + 1] as CompactionRange;
      const gap = right.from_seq - left.to_seq - 1;
      if (gap >= smallestGap) continue;
      smallest = index;
      smallestGap = gap;
    }
    const left = merged[smallest] as CompactionRange;
    const right = merged[smallest + 1] as CompactionRange;
    merged[smallest] = {
      from_seq: left.from_seq,
      to_seq: right.to_seq,
      messages: left.messages + right.messages,
    };
    merged = merged.filter((_, index) => index !== smallest + 1);
  }
  return merged;
}

/** 由入参构造一条索引条目（纯函数：不读盘、不读实例状态）。 */
export function buildCompactionIndexEntry(input: BuildCompactionIndexInput): CompactionIndexEntry {
  const fingerprint = summaryFingerprint(input.summary);
  const { ranges, unmapped } = removedRangesFromSeqs(input.removedSeqs);
  return {
    compaction_id: input.compaction_id,
    at: input.at,
    reason: input.reason,
    removed: input.removedSeqs.length,
    removed_ranges: ranges,
    unmapped_messages: unmapped,
    replaced_by: {
      summary_chars: fingerprint.summary_chars,
      summary_sha8: fingerprint.summary_sha8,
    },
    summary_head: fingerprint.summary_head,
    tokens_before: Math.max(0, Math.round(input.tokens_before)),
    tokens_after: Math.max(0, Math.round(input.tokens_after)),
  };
}

/**
 * 把索引渲染成**极短 stub**（在压缩替换的位置注入，而不是把原文塞回去）。
 *
 * 形状（一段一行）：
 *
 * ```
 * [compacted] 766 messages (seq 118001..125660) were summarized; call recall with compaction_id=2 to read them back.
 * ```
 *
 * 为什么这么短：stub 每一轮请求都要付 token。它要回答的只有两件事 ——「这里缺了多少东西」
 * 与「怎么拿回来」，其余（摘要正文、区间明细）都已经在上下文或工具里。
 *
 * **前缀稳定**：输出是 `entries` 的纯函数，且 `entries` 只在压缩那一刻追加 ⇒ 同一份索引
 * 两次渲染逐字节相同。
 */
export function formatCompactionStub(entries: readonly CompactionIndexEntry[]): string {
  if (entries.length === 0) return '';
  const shown = entries.slice(-COMPACTION_STUB_MAX_ENTRIES);
  const lines: string[] = [];
  for (const entry of shown) lines.push(compactionStubLine(entry));
  const hidden = entries.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `[compacted] ${String(hidden)} earlier segment(s) are also readable; call recall with no arguments to list them.`,
    );
  }
  return lines.join('\n');
}

/** 一段压缩的 stub 行（区间可能有多段：用首尾 + 段数表达，明细留给 `recall`）。 */
function compactionStubLine(entry: CompactionIndexEntry): string {
  const first = entry.removed_ranges[0];
  const last = entry.removed_ranges[entry.removed_ranges.length - 1];
  const span =
    first === undefined || last === undefined
      ? ''
      : entry.removed_ranges.length === 1
        ? ` (seq ${String(first.from_seq)}..${String(last.to_seq)})`
        : ` (seq ${String(first.from_seq)}..${String(last.to_seq)} in ${String(entry.removed_ranges.length)} ranges)`;
  const unmapped =
    entry.unmapped_messages > 0
      ? ` [${String(entry.unmapped_messages)} without a seq mapping]`
      : '';
  return `${COMPACTION_STUB_MARK} ${String(entry.removed)} messages${span} were summarized${unmapped}; call recall with compaction_id=${String(entry.compaction_id)} to read them back.`;
}

/**
 * 把 stub 追加到「这次压缩产出的摘要消息」正文末尾（压缩那一刻**只写一次**）。
 *
 * 为什么直接改摘要消息：替换语义下，摘要消息就是「被删掉那 766 条所在的位置」。把 stub
 * 拼在它后面，模型读到的是「这段历史被摘要了，原文可以按 id 读回」，位置与事实一致；
 * 追加一条新的相邻消息需要往窗口中间插队（当前没有这样的 API，也不该为它开一个）。
 *
 * 返回值 = 是否真的写入了。找不到摘要消息（降级 / 并发压缩已换段）⇒ `false`，
 * 调用方据此知道「这次没有 stub」，不假装写过。
 *
 * ⚠️ 已知代价：窗口的整窗上界估算（`MemoryWorkingContext` 的缓存）是在压缩应用时算的，
 * 这里追加的几十个 token 不在其中 ⇒ 该会话的整窗估算**偏低** stub 长度（每段 ≤ ~150
 * token；下一次压缩按实际内容重算，不累积放大）。
 */
export function appendCompactionStub(messages: readonly Message[], stub: string): boolean {
  if (stub.trim() === '') return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'system' || message.compaction_summary !== true) continue;
    const existing = message.content;
    // 幂等：同一段重复渲染不叠加（重放 / 二次发布都走这里）。
    if (existing.includes(COMPACTION_STUB_MARK)) return false;
    message.content = existing === '' ? stub : `${existing}\n\n${stub}`;
    return true;
  }
  return false;
}

/**
 * 去掉正文里的 stub 行（摘要的**指纹与摘要器输入**只认纯摘要）。
 *
 * 为什么要削：`previousSummary` 会作为下一次摘要的输入，把「[compacted] … call recall …」
 * 一起喂给摘要器等于往摘要里灌机制噪音；`summary_sha8` 也必须只对摘要正文成立，
 * 否则「同一份摘要」在有没有 stub 时算出两个指纹。
 */
export function stripCompactionStub(text: string): string {
  if (!text.includes(COMPACTION_STUB_MARK)) return text;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(COMPACTION_STUB_MARK)) continue;
    kept.push(line);
  }
  // 末尾可能留下与 stub 之间的空行：削到最后一个非空行为止。
  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === '') kept.pop();
  return kept.join('\n');
}
