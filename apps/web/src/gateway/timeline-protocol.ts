/**
 * timeline 单游标握手（ADR-105 §6）的**协议适配层**：纯函数，不碰 RPC、不碰 store。
 *
 * 三件事，各自只有一个入口：
 * 1. `readTimelineCursor` —— 把 `sessions.get.event_cursor` 的 timeline 四字段
 *    （`timeline_head` / `wal_head` / `holes` / `tainted`）收敛成 `TimelineCursor`。
 *    四字段**一起出现或一起缺省**（ADR-105 §11.1）：缺省 = 没有 timeline，返回
 *    `undefined`（**不报假零**）。
 * 2. `planBackfill` —— 由一个游标 + 客户端游标算出**一段**回填区间的声明
 *    （`TimelineRangeHeader`）。分页只在区间内部发生，**没有第二阶段、没有时间截断**。
 *    proto-b1 的 `timeline.hello` 合入后，头部改由帧自带（同样的七字段），本函数只剩
 *    「还没有 hello 时的兜底」，调用点不变 —— 这就是「不硬编码帧形状」的落点。
 * 3. `validateTimelineRange` —— 四条客户端校验（ADR-105 §6，全部硬）。任一条不成立 ⇒
 *    调用方**不合并**、报 `timeline_gap_reported{expected, received}`、重拉该区间。
 *
 * 三条不变式：seq 严格升序（连续性）/ 实收条数 === `count` / 首末条贴住区间边界；
 * 再加一条「重复不许静默吸收」。**洞是声明**（`holes`），不是猜：区间内被声明成洞的
 * seq 本来就不该收到，校验要按声明把它们从期望集合里减掉。
 */

import type { RunEvent } from './types';

/** 一**个**洞区间（`event_cursor.holes` 的元素；只给区间，不带原因 / 时间）。 */
export interface TimelineHoleRange {
  from_seq: number;
  to_seq: number;
}

/** `sessions.get.event_cursor` 的 timeline 四字段（齐全才有值）。 */
export interface TimelineCursor {
  timeline_head: number;
  wal_head: number;
  holes: readonly TimelineHoleRange[];
  tainted: boolean;
}

/**
 * 一段回填区间的**声明**（客户端据此校验，服务端 `timeline.hello` 落地后由帧自带）。
 *
 * `count` = 闭区间 `[start_seq, end_seq]` 的长度减去落在其中的洞长度：
 * 「应该收到几条」，不是「服务端有几条」。`reset` 只有两种成因（N > `wal_head`，
 * 或会话被冻结后重开）：游标作废、从 1 重新拉。
 */
export interface TimelineRangeHeader {
  start_seq: number;
  end_seq: number;
  count: number;
  timeline_head: number;
  wal_head: number;
  holes: readonly TimelineHoleRange[];
  tainted: boolean;
  reset?: boolean;
}

/** wire 上一条事件（`seq` 就是 `timeline_seq`，全仓唯一的时间线坐标）。 */
export interface TimelineEvent {
  seq: number;
  type: string;
  run_id?: string;
  ts: number;
  data?: unknown;
}

/** 四条校验各对应一个编号（回报 / UI 文案 / 门禁用同一个编号）。 */
export type TimelineRule = 1 | 2 | 3 | 4;

/** 缺口从哪来：四条校验 / RPC 拿不全 / 服务端 gap 帧（旧的混合语义，只能如实转记）。 */
export type TimelineGapSource = 'range' | 'fetch' | 'server' | 'holes';

/**
 * 一次**已声明**的缺口（`timeline_gap_reported` 的载荷）。
 *
 * 为什么要 `expected` / `received`：只说「有缺口」既不能定位也不能回归；ADR-105 §6 要求
 * 报这两项。`from_seq` / `to_seq` 是区间（闭），UI 的污点条直接用它。
 */
export interface TimelineGapReport {
  from_seq: number;
  to_seq: number;
  source: TimelineGapSource;
  rule?: TimelineRule;
  /** 给人看的期望 / 实收（诊断与 UI 文案）。 */
  expected: string;
  received: string;
  /** 给服务端记账的两个数（`timeline_gap` 帧的 `expected` / `received`）。 */
  expectedCount?: number;
  receivedCount?: number;
  at: number;
}

/** 游标的可读状态（UI 污点条 / 诊断页读它；`last` 是**最近一次**，不是累计）。 */
export interface TimelineGapState {
  /** 累计报过几次（含被后续重拉补上的）。 */
  reports: number;
  /** 历史里出现过缺口且没被重拉覆盖 ⇒ 会话有一段不可读。 */
  tainted: boolean;
  last?: TimelineGapReport;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 洞区间的形状校验：`from_seq <= to_seq` 且两端都是整数，否则整条丢掉（不猜）。 */
function readHoles(raw: unknown): TimelineHoleRange[] {
  if (!Array.isArray(raw)) return [];
  const holes: TimelineHoleRange[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { from_seq?: unknown; to_seq?: unknown };
    if (!isSeq(record.from_seq) || !isSeq(record.to_seq)) continue;
    if (record.to_seq < record.from_seq) continue;
    holes.push({ from_seq: record.from_seq, to_seq: record.to_seq });
  }
  return holes;
}

/**
 * `hello.timeline`（0.54 B1 的**真实帧**）→ 回填 / 校验的头。
 *
 * 与 `readTimelineCursor` + `planBackfill` 的分工：那条路是**没有 hello 时**的兜底
 * （`sessions.get.event_cursor` 四字段 + 客户端游标自己算区间）；proto-b1 合入后，区间与
 * `count` 由服务端**声明**，客户端只核对。两者产出同一个 `TimelineRangeHeader`，
 * 所以四条校验与 `applyTimelineRange` 一行都不用改 —— 这就是「不硬编码帧形状」的落点。
 *
 * 只认 `timeline_source === 'timeline'` 才有字段；形状不全 ⇒ `undefined`（不猜）。
 */
export function readTimelineHelloSegment(
  source: unknown,
  raw: unknown,
): TimelineRangeHeader | undefined {
  if (source !== 'timeline') return undefined;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const start = record.start_seq;
  const end = record.end_seq;
  const count = record.count;
  const timelineHead = record.timeline_head;
  const walHead = record.wal_head;
  if (!isSeq(start) || !isSeq(end) || !isSeq(count)) return undefined;
  if (!isSeq(timelineHead) || !isSeq(walHead)) return undefined;
  return {
    start_seq: start,
    end_seq: end,
    count,
    timeline_head: timelineHead,
    wal_head: walHead,
    holes: readHoles(record.holes),
    tainted: record.tainted === true,
    ...(record.reset === true ? { reset: true } : {}),
  };
}

/**
 * 缺口 → 线上帧（`{kind:'timeline_gap'}`，见 `packages/serve/src/gateway.ts` 的接收面）。
 *
 * `expected` / `received` 在线上是**数字**（条数），所以报告里必须留着这两个数：
 * 文案给人看，数字给服务端记账。四条校验各有 `check` 编号，服务端按它分流。
 */
export function gapWireFrame(
  report: TimelineGapReport,
  after?: number,
  sessionId?: string,
): {
  session_id?: string;
  expected?: number;
  received?: number;
  start_seq?: number;
  end_seq?: number;
  after_timeline_seq?: number;
  check?: TimelineRule;
} {
  return {
    ...(sessionId !== undefined && sessionId !== '' ? { session_id: sessionId } : {}),
    ...(report.expectedCount !== undefined ? { expected: report.expectedCount } : {}),
    ...(report.receivedCount !== undefined ? { received: report.receivedCount } : {}),
    start_seq: report.from_seq,
    end_seq: report.to_seq,
    ...(after !== undefined ? { after_timeline_seq: after } : {}),
    ...(report.rule !== undefined ? { check: report.rule } : {}),
  };
}

/**
 * `sessions.get.event_cursor` → `TimelineCursor`。
 *
 * 四字段**必须同现**：只给 `wal_head` 而不给 `holes` 的响应说明对端是半截实现，把它当
 * 「没有 timeline」处理（fail-open 到「只有实时流」），绝不补零假装完整。
 */
export function readTimelineCursor(raw: unknown): TimelineCursor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!isSeq(record.timeline_head) || !isSeq(record.wal_head)) return undefined;
  if (record.timeline_head > record.wal_head) return undefined;
  return {
    timeline_head: record.timeline_head,
    wal_head: record.wal_head,
    holes: readHoles(record.holes),
    tainted: record.tainted === true,
  };
}

/** `seq` 是否落在任一声明的洞里。 */
export function inHoles(seq: number, holes: readonly TimelineHoleRange[]): boolean {
  for (const hole of holes) {
    if (seq >= hole.from_seq && seq <= hole.to_seq) return true;
  }
  return false;
}

/** 闭区间 `[from, to]` 里被洞覆盖的 seq 条数（区间外的洞不计）。 */
function holeCount(from: number, to: number, holes: readonly TimelineHoleRange[]): number {
  let covered = 0;
  for (const hole of holes) {
    const start = Math.max(from, hole.from_seq);
    const end = Math.min(to, hole.to_seq);
    if (end >= start) covered += end - start + 1;
  }
  return covered;
}

/**
 * 由游标 + 客户端游标算出**一段**回填区间的声明。
 *
 * - 已经追平（`after >= wal_head`）⇒ `undefined`：没有要补的区间（不是「空区间」）。
 * - `after > wal_head`（服务端重启 / 会话重开导致的游标作废）⇒ `reset`：从 1 重拉整段。
 * - 否则 `[after + 1, wal_head]`：**一个区间**，一次拿完（分页只在区间内部）。
 *
 * 时间不参与：ADR-105 §3.4 明文「UI 不得自行按 ts 排 / 按 ts 截断」，所以这里没有任何
 * 时间截断参数（那一套随三源读路径一起删除，不再有第二个入口）。
 */
export function planBackfill(
  cursor: TimelineCursor,
  after: number,
): TimelineRangeHeader | undefined {
  const from = Number.isInteger(after) && after > 0 ? after : 0;
  if (from > cursor.wal_head) {
    return {
      ...planRange(cursor.wal_head > 0 ? 1 : 0, cursor.wal_head, cursor),
      reset: true,
    };
  }
  if (from >= cursor.wal_head) return undefined;
  return planRange(from + 1, cursor.wal_head, cursor);
}

/**
 * 声明任意一段区间 `[start_seq, end_seq]`（回填 / 缺口重拉共用）。
 *
 * `count` 减掉落在区间里的**声明洞**：洞里的 seq 本来就不该收到，期望条数要按声明算。
 */
export function planRange(
  start_seq: number,
  end_seq: number,
  cursor: TimelineCursor,
): TimelineRangeHeader {
  const start = Number.isInteger(start_seq) ? Math.max(0, start_seq) : 0;
  const end = Number.isInteger(end_seq) ? Math.max(start, end_seq) : start;
  const holes = cursor.holes.filter((hole) => hole.to_seq >= start && hole.from_seq <= end);
  return {
    start_seq: start,
    end_seq: end,
    count: end >= start ? end - start + 1 - holeCount(start, end, holes) : 0,
    timeline_head: cursor.timeline_head,
    wal_head: cursor.wal_head,
    holes,
    tainted: cursor.tainted,
  };
}

/** 区间内第一条「应该在」的 seq（起点的洞按声明跳过）；空区间返回 `undefined`。 */
export function firstExpectedSeq(header: TimelineRangeHeader): number | undefined {
  for (let seq = header.start_seq; seq <= header.end_seq; seq += 1) {
    if (!inHoles(seq, header.holes)) return seq;
  }
  return undefined;
}

/** 区间内最后一条「应该在」的 seq。 */
export function lastExpectedSeq(header: TimelineRangeHeader): number | undefined {
  for (let seq = header.end_seq; seq >= header.start_seq; seq -= 1) {
    if (!inHoles(seq, header.holes)) return seq;
  }
  return undefined;
}

/**
 * 四条客户端校验（ADR-105 §6，**全部硬**）。返回 `undefined` = 这一段可以合并。
 *
 * 1. **连续性**：`seq` 严格升序，且相邻两条之间只允许被声明的洞跳过 —— 不许有「静默
 *    的中间缺一条」。
 * 2. **count**：实收条数 `===` 声明 `count`（区间长度减洞）。
 * 3. **边界**：首条 `===` 区间内第一个非洞 seq，末条 `===` 区间内最后一个非洞 seq。
 * 4. **重复**：出现重复 seq ⇒ 不合并（今天的 `push` 只丢 `seq <= lastSeq`，重复被静默
 *    吸收，那正是要消掉的行为）。
 *
 * 顺序无关：调用方传进来前按 seq 排好（`applyTimelineRange` 内部排序），这里只判。
 */
export function validateTimelineRange(
  header: TimelineRangeHeader,
  seqs: readonly number[],
): TimelineGapReport | undefined {
  const from = header.start_seq;
  const to = header.end_seq;
  const make = (
    rule: TimelineRule,
    expected: string,
    received: string,
    counts?: { expected: number; received: number },
  ): TimelineGapReport => ({
    from_seq: from,
    to_seq: to,
    source: 'range',
    rule,
    expected,
    received,
    ...(counts !== undefined
      ? { expectedCount: counts.expected, receivedCount: counts.received }
      : {}),
    at: Date.now(),
  });
  const first = firstExpectedSeq(header);
  const last = lastExpectedSeq(header);
  // 空区间（整段都被声明成洞）：实收必须为 0。
  if (first === undefined || last === undefined) {
    return seqs.length === 0 ? undefined : make(3, '0 条（整段已声明为洞）', `${seqs.length} 条`);
  }
  const head = seqs[0];
  const tail = seqs[seqs.length - 1];
  // 3. 边界（先判：首末不对时下面的连续 / count 判据都会连带红，报错要指得准）。
  if (head !== first || tail !== last) {
    return make(3, `首 ${first} / 末 ${last}`, `首 ${String(head)} / 末 ${String(tail)}`, {
      expected: header.count,
      received: seqs.length,
    });
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const seq of seqs) {
    // 4. 重复（同时也是「升序」的反面：相等即重复）。
    if (seq === previous) return make(4, '无重复 seq', `重复 seq=${seq}`);
    if (seq < previous) return make(1, '严格升序', `${previous} → ${seq}`);
    // 1. 连续性：中间只允许被声明的洞跳过。
    if (previous !== Number.NEGATIVE_INFINITY && seq !== previous + 1) {
      let expected = previous + 1;
      while (expected < seq && inHoles(expected, header.holes)) expected += 1;
      if (expected !== seq) {
        return make(1, `接在 ${previous} 之后的是 ${expected}`, `实收 ${seq}`);
      }
    }
    previous = seq;
  }
  // 2. count。
  if (seqs.length !== header.count) {
    return make(2, `${header.count} 条`, `${seqs.length} 条`, {
      expected: header.count,
      received: seqs.length,
    });
  }
  return undefined;
}

/** 形状校验：不像事件的条目直接丢（不猜、不补 0）。 */
export function normalizeTimelineEvent(raw: unknown): TimelineEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!isSeq(record.seq) || record.seq < 1) return undefined;
  if (typeof record.type !== 'string' || record.type.length === 0) return undefined;
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return undefined;
  return {
    seq: record.seq,
    type: record.type,
    ts: record.ts,
    ...(typeof record.run_id === 'string' ? { run_id: record.run_id } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

/** 一页的 wire 形状（`sessions.events` 的结果；分页只在区间内部用）。 */
export interface TimelinePage {
  events: TimelineEvent[];
  next_seq?: number;
  latest_seq?: number;
  has_more?: boolean;
  /** 拉取层面已经知道的原因（旧 gateway 没有该方法 / 超时）；有值时区间按缺失处理。 */
  error?: string;
}

/** 单次区间的页数硬上限（防 WAN 上首屏被拖死；触顶 ⇒ 声明式缺口，不静默截断）。 */
export const MAX_TIMELINE_RANGE_PAGES = 200;

/** 一次区间拉取的结果（`collectTimelineRange`）。 */
export interface TimelineRangeFetch {
  events: TimelineEvent[];
  pages: number;
  /** 失败 / 触顶原因（有值 ⇒ 调用方仍走校验，校验会如实报缺口）。 */
  error?: string;
}

/**
 * 把**一个区间**的页拼齐（区间内部翻页，不改变区间）。
 *
 * 只认 `has_more` + 游标前进这两条停止条件；页游标不前进就停手（服务端异常 / 日志被截，
 * 在这里转圈是最坏的形态）。页数上限是硬上界，触顶**如实**记 `error` —— 由调用方的四条
 * 校验把它变成可见的缺口，而不是「少了几条但没人知道」。
 */
export async function collectTimelineRange(
  header: TimelineRangeHeader,
  fetchPage: (sinceSeq: number, limit: number) => Promise<TimelinePage>,
  pageLimit = 500,
): Promise<TimelineRangeFetch> {
  const events: TimelineEvent[] = [];
  let since = header.start_seq - 1;
  let pages = 0;
  for (; pages < MAX_TIMELINE_RANGE_PAGES && since < header.end_seq; pages += 1) {
    let page: TimelinePage;
    try {
      page = await fetchPage(since, pageLimit);
    } catch (error) {
      return {
        events,
        pages,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (page.error !== undefined) return { events, pages, error: page.error };
    let maxSeq = since;
    for (const event of page.events) {
      if (event.seq <= since) continue;
      events.push(event);
      if (event.seq > maxSeq) maxSeq = event.seq;
    }
    // 游标没前进 / 已经追到区间右端：停。
    if (maxSeq <= since || maxSeq >= header.end_seq || page.has_more !== true) {
      return { events, pages };
    }
    since = maxSeq;
  }
  const done = since >= header.end_seq;
  return done && pages < MAX_TIMELINE_RANGE_PAGES
    ? { events, pages }
    : { events, pages, error: 'range page cap reached' };
}

/**
 * wire 事件 → 渲染侧的 `RunEvent`（缺 `data` 时给空对象，别让 fold 到处判空）。
 *
 * 只在**装配面**做这一次转换：`seq` 就是 `timeline_seq`，item 身份 / 排序 / 去重都认它。
 */
export function toRunEvent(event: TimelineEvent): RunEvent {
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

/** `sessions.events` 的一页 → `TimelinePage`（形状不合的条目直接丢，不猜）。 */
export function readTimelinePage(body: unknown): TimelinePage {
  if (typeof body !== 'object' || body === null) return { events: [] };
  const record = body as {
    events?: unknown;
    next_seq?: unknown;
    latest_seq?: unknown;
    has_more?: unknown;
  };
  const events: TimelineEvent[] = [];
  for (const raw of Array.isArray(record.events) ? record.events : []) {
    const event = normalizeTimelineEvent(raw);
    if (event !== undefined) events.push(event);
  }
  return {
    events,
    ...(isSeq(record.next_seq) ? { next_seq: record.next_seq } : {}),
    ...(isSeq(record.latest_seq) ? { latest_seq: record.latest_seq } : {}),
    ...(record.has_more === true ? { has_more: true } : {}),
  };
}
