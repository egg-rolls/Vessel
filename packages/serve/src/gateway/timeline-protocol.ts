/**
 * timeline 握手协议（0.54 B1）：`hello` 的时间线段、`read_from` 切读开关、读端口。
 *
 * ## 这个模块解决什么
 * ADR-105 §6 规定客户端**只持有一个游标** `client_timeline_seq`；服务端在每个 epoch 的
 * `hello` 里声明「本次要发的区间 + 可读条数 + 两指针 + 洞」，客户端按四条硬校验核对，
 * 对不上就报 `timeline.gap_reported` 并重拉该区间。B1 之前 `hello` 只有
 * `{from_seq, latest_seq}`，缺的正是这套**可校验的声明**。
 *
 * ## `count` 的语义（唯一口径，别再造第二个）
 * `count` = **本 epoch 声明的区间里，服务端会发出的可读事件条数**。
 * 时间线读源上「有效区间」= `[start_seq, min(end_seq, published_head)]`，且时间线订阅按契约
 * 不带类型过滤，于是它与 ADR-105 §6 的公式**逐字相等**：
 *
 *     count = (有效右端 - start_seq + 1) - Σ|holes ∩ [start_seq, 有效右端]|
 *
 * 六条边界写死（不是措辞，是判据）：
 * - `end_seq` 是**闭区间右端**，取 `wal_head`：`[1..wal_head]` 每条要么可读、要么已被
 *   `holes` 声明（[unacked-queue-closure.md] §1）。**不是**页末、也**不是** `timeline_head`
 *   ——后者只是「已归档到哪」，拿它当右端会把 WAL 段当成缺口。
 * - `published_head`（pub-i2 的崩溃窗口产物）：**一定被发布过**的最大 seq。`published_head <
 *   wal_head` 时 `(published_head, wal_head]` 是**允许不被推送**的尾部 —— 客户端不得据它报
 *   `timeline.gap_reported`，也不许把它算进期望条数。所以 `count` 只算有效右端以内，
 *   `holes` 也只裁到有效右端以内（尾部既没发、也不该被声明成洞：洞是「可读性」事实，
 *   未发布是「推送」事实，两种语义绝不混进同一个字段 —— ADR-105 §9 R4）。
 *   写者侧口径：`published` 只在 fsync 之后推进（`writer.ts:796` / `:807`），open 时折成
 *   `this.published = this.walHead`（`writer.ts:486`），所以重启后两者必然相等、
 *   这条声明只在「本次进程里有未发布尾部」时起作用。
 * - `start_seq` = `after_timeline_seq + 1`（排他游标的下一条），**可以**落在洞里；
 *   客户端第一条实收 = 该洞之后第一个非洞 seq（§6 校验 1）。
 * - `count` 是**整段区间**的条数，不是单页条数：分页只决定「这一趟发多少帧」（≤ 500 条 /
 *   ≤ 8 MiB），不改声明。客户端攒到有效右端再核（§6 校验 3 + 校验 4）。
 * - `after_timeline_seq > wal_head` ⇒ `reset: true` 且 `start_seq = 1`（本地游标已越过
 *   服务端事实，只能整段重拉；§6 的两种 reset 之一）。此时 `count` 也按 `[1, 有效右端]` 算。
 * - `count` 永不为负：洞可以盖满整段区间（= 0），洞区间互相重叠先**归并**再算，
 *   所以「`holes` 里两条重叠」不会把 `count` 多减一次。
 *
 * ## 老客户端为什么不受影响（additive 的具体含义）
 * 新字段是**加**在同一个 `kind:'hello'` 帧上的：不改 `kind`、不改 `from_seq` /
 * `latest_seq` 的口径。老客户端按 `from_seq` 起、忽略不认识的键 ⇒ 行为一字节不变。
 * 另外 `timeline_source` 标出本次 epoch 的读源：只有 `'timeline'` 才做四条校验，
 * `'legacy'`（回退期 / 旧订阅）仍是老行为 —— 两种编号（进程级 hub seq 与 session
 * timeline_seq）绝不混在同一个 epoch 里（ADR-105 §9 R7）。
 *
 * @module @vessel-agent/serve/gateway/timeline-protocol
 */

/** 切读开关的取值（进程级、装配层读一次；见 §3.2 与 ADR-104 D7）。 */
export type TimelineReadFrom = 'timeline' | 'legacy';

/** 缺省读源：时间线（回退通道在 B 阶段末尾随 C 阶段一起删除）。 */
export const DEFAULT_TIMELINE_READ_FROM: TimelineReadFrom = 'timeline';

/** 单页上限（ADR-105 §6：每页 ≤ 500 条，另有 8 MiB 字节上限在装配侧）。 */
export const TIMELINE_PAGE_LIMIT = 500;

/** 一个洞区间（对外字段名与 `sessions.get.event_cursor.holes` 一致）。 */
export interface TimelineHoleRange {
  from_seq: number;
  to_seq: number;
}

/** 两指针 + 洞 + 污点（与 `SessionTimelineHeadsPort` 的返回同形）。 */
export interface TimelineHeadsLike {
  timeline_head: number;
  wal_head: number;
  holes: readonly TimelineHoleRange[];
  tainted: boolean;
  /**
   * **一定被发布过**的最大 seq（pub-i2；`published_head <= wal_head`）。
   *
   * 可选是因为 core 的 `heads()` 只报对外四字段（`writer.ts:370-379`），
   * `publishedHead()` 是**另一个方法**（`writer.ts:381`，注释写明「不属于对外四字段」）；
   * 装配层要显式透传。**没给时按 `wal_head` 兜底**，这不是「放宽」而是 pub-i2 之前
   * 装配的既有语义：没有未发布尾部的实现，等价于「全部都已发布」
   * （core 自己在 open 时也是 `this.published = this.walHead`，`writer.ts:486`）。
   */
  published_head?: number;
}

/** 时间线上的一个事件（线上形状与 `sessions.events` 的事件体同形）。 */
export interface TimelineWireEvent {
  seq: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: unknown;
}

/**
 * 时间线分页读端口（装配层注入：`readTimelineEvents` 那一路）。
 *
 * `afterSeq` **排他**（只回 `seq > afterSeq`），`untilSeq` 含（只回 `seq <= untilSeq`），
 * 返回按 `seq` 升序、无重复、最多 `limit` 条。serve 不拼磁盘路径、不读盘，
 * 与 `SessionEventsPort` 同一范式；缺省 = 未注入 ⇒ 时间线订阅**拒绝**（不偷偷回落到
 * 环形的另一套 seq）。
 */
export interface TimelineReadPort {
  readPage(
    sessionId: string,
    options: { afterSeq: number; untilSeq?: number; limit?: number },
  ): Promise<readonly TimelineWireEvent[]>;
}

/**
 * 实时尾随端口（装配层注入：`timelineTailPort(dualWrite)`）。
 *
 * 语义（`pub-i2` 实测口径，serve 侧只负责后半段）：
 * - 回调在写者 **fsync 之后**逐条触发，`seq` 就是会话内 `timeline_seq`，严格递增；
 * - 扇出是**进程/租户级**的（一条发布可能属于任何会话），所以 `session_id` 随事件给出，
 *   serve 必须按连接的 `session_id` 过滤 —— 端口不做游标过滤（那只有连接自己知道）；
 * - 端口**不重发历史页**：历史由 `TimelineReadPort` 给，尾随只负责「这条以后」。
 * - 返回退订函数；`startGateway` 在 `stop()` 里调用它。
 */
export type TimelineTailPort = (
  listener: (event: TimelineWireEvent & { session_id: string }) => void,
) => () => void;

/** `hello` 的时间线段（全字段都是 additive）。 */
export interface TimelineHelloSegment {
  start_seq: number;
  end_seq: number;
  count: number;
  timeline_head: number;
  wal_head: number;
  /** 一定被发布过（`<= wal_head`）；`(published_head, wal_head]` 允许不被推送。 */
  published_head: number;
  holes: TimelineHoleRange[];
  tainted: boolean;
  reset?: true;
}

/**
 * 读一次 `read_from` 开关（**装配层**调用；core / 读路径里不得再读环境变量）。
 *
 * 非法值 **fail loud**：静默回落到缺省会让人以为「已经切回旧源」，而那正是回退期
 * 最不能搞错的一件事（计划书 §3.2 / C-3 同口径）。
 */
export function resolveTimelineReadFrom(raw: unknown): TimelineReadFrom {
  if (raw === undefined || raw === null) return DEFAULT_TIMELINE_READ_FROM;
  if (raw === 'timeline' || raw === 'legacy') return raw;
  throw new Error(
    `timeline.read_from 只接受 'timeline' | 'legacy'，收到 ${JSON.stringify(raw)}（拒绝静默回落）`,
  );
}

/** 非负整数 seq；其它（NaN / 负数 / 小数 / 非数字）一律按 0 —— 不猜也不抛。 */
function clampSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const seq = Math.floor(value);
  return seq > 0 ? seq : 0;
}

/**
 * 归并洞区间：按 `from_seq` 升序、相邻/重叠合并、丢掉坏声明（`to_seq < from_seq`、
 * `from_seq < 1`）。
 *
 * 归并是 `count` 正确性的前提：两条重叠洞若各自减一次，`count` 会比实收少，
 * 客户端于是把**服务端写错**报成 gap。坏声明丢弃而不猜（洞是「声明」不是「推测」）。
 */
export function normalizeHoles(
  holes: readonly TimelineHoleRange[] | undefined,
): TimelineHoleRange[] {
  const ranges: TimelineHoleRange[] = [];
  for (const hole of holes ?? []) {
    const from = clampSeq(hole.from_seq);
    const to = clampSeq(hole.to_seq);
    if (from < 1 || to < from) continue;
    ranges.push({ from_seq: from, to_seq: to });
  }
  ranges.sort((a, b) => a.from_seq - b.from_seq || a.to_seq - b.to_seq);
  const merged: TimelineHoleRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from_seq <= last.to_seq + 1) {
      last.to_seq = Math.max(last.to_seq, range.to_seq);
      continue;
    }
    merged.push({ from_seq: range.from_seq, to_seq: range.to_seq });
  }
  return merged;
}

/** 把洞裁进 `[start, end]`（线上只声明本次区间内的洞；归并过，所以不会重复计）。 */
export function clipHoles(
  holes: readonly TimelineHoleRange[],
  start: number,
  end: number,
): TimelineHoleRange[] {
  if (end < start) return [];
  const clipped: TimelineHoleRange[] = [];
  for (const hole of normalizeHoles(holes)) {
    if (hole.to_seq < start) continue;
    if (hole.from_seq > end) break;
    clipped.push({
      from_seq: Math.max(hole.from_seq, start),
      to_seq: Math.min(hole.to_seq, end),
    });
  }
  return clipped;
}

/** `[start, end]` 里被洞覆盖的 seq 条数（入参须已归并，否则重叠会被重复计）。 */
export function countHolesInRange(
  start: number,
  end: number,
  holes: readonly TimelineHoleRange[],
): number {
  if (end < start) return 0;
  let covered = 0;
  for (const hole of holes) {
    if (hole.to_seq < start) continue;
    if (hole.from_seq > end) break;
    const from = Math.max(hole.from_seq, start);
    const to = Math.min(hole.to_seq, end);
    if (to >= from) covered += to - from + 1;
  }
  return covered;
}

/** `count` 的实现：闭区间长度减去洞覆盖数，**不截断成负数**。 */
export function countReadableInRange(
  start: number,
  end: number,
  holes: readonly TimelineHoleRange[],
): number {
  if (end < start) return 0;
  return Math.max(0, end - start + 1 - countHolesInRange(start, end, normalizeHoles(holes)));
}

/**
 * 由 `after_timeline_seq` + 两指针 + `published_head` 算出 `hello` 的时间线段
 * （纯函数，无 IO）。
 *
 * `timeline_head` 按不变式取 `min(timeline_head, wal_head)`：归档只可能落后、不可能超前
 * （unacked-queue-closure.md §1），读数越界说明磁盘口径坏了 —— 这里**收紧**它而不是
 * 把矛盾值往线上发。`published_head` 同样收紧到 `<= wal_head`，并且**只用来界定
 * 「这一次会发到哪」**：`end_seq` 仍是 `wal_head`（可读性事实），有效右端才是
 * `min(wal_head, published_head)`（推送事实）。两种事实分两个字段，绝不合并成一个 ——
 * 洞只描述可读性，未发布尾部不许被写成洞（ADR-105 §9 R4）。
 */
export function timelineHello(input: {
  afterTimelineSeq: number;
  heads: TimelineHeadsLike;
}): TimelineHelloSegment {
  const walHead = clampSeq(input.heads.wal_head);
  const timelineHead = Math.min(clampSeq(input.heads.timeline_head), walHead);
  // 端口没报 published_head ⇒ 全部视为已发布（pub-i2 之前的装配语义，见类型注释）。
  const publishedHead = Math.min(
    input.heads.published_head === undefined ? walHead : clampSeq(input.heads.published_head),
    walHead,
  );
  const after = clampSeq(input.afterTimelineSeq);
  const reset = after > walHead;
  const start = reset ? 1 : after + 1;
  // 有效右端 = 这次真的会发的最后一条（未发布尾部不算）。
  const effectiveEnd = Math.min(walHead, publishedHead);
  const holes = clipHoles(input.heads.holes, start, effectiveEnd);
  return {
    start_seq: start,
    end_seq: walHead,
    count: countReadableInRange(start, effectiveEnd, holes),
    timeline_head: timelineHead,
    wal_head: walHead,
    published_head: publishedHead,
    holes,
    tainted: input.heads.tainted === true,
    ...(reset ? { reset: true as const } : {}),
  };
}

/**
 * 从一页记录里裁出要发的那一页：`start_seq <= seq <= end_seq`、去重、升序、最多 `limit`。
 *
 * 去重不是「读侧掩盖写侧」：洞/块是**声明**过的不可读区间，同一条事件从
 * `timeline.ndjson` 与 `wal.log` 各来一次属于归档「复制不是搬移」的正常形态
 * （ADR-105 §11.1），线上只认一条。
 */
export function selectTimelinePage(
  records: readonly TimelineWireEvent[],
  startSeq: number,
  endSeq: number,
  limit = TIMELINE_PAGE_LIMIT,
): TimelineWireEvent[] {
  const seen = new Set<number>();
  const page: TimelineWireEvent[] = [];
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const seq = clampSeq(record.seq);
    if (seq < startSeq || seq > endSeq) continue;
    if (seen.has(seq)) continue;
    seen.add(seq);
    page.push(record);
    if (page.length >= Math.max(1, limit)) break;
  }
  return page;
}

/** `decideTimelineSubscribe` 的输入（每个字段都是「已知事实」，不在里面做 IO）。 */
export interface TimelineSubscribeInput {
  /** `events.subscribe.after_timeline_seq`；缺省 = 老订阅（不做时间线校验）。 */
  afterTimelineSeq: number | undefined;
  /** 同一次订阅里是否也给了 `since`（时间线订阅上 `since` 被拒，ADR-105 §6）。 */
  sinceGiven: boolean;
  sessionId: string | undefined;
  readFrom: TimelineReadFrom;
  /** `timelineHeads` 端口是否注入（false = 装配层没开 timeline 读面）。 */
  headsInjected: boolean;
  /** `lookup(sessionId)` 的结果；`undefined` = 该会话没有任何 timeline 标记（旧格式会话）。 */
  heads: TimelineHeadsLike | undefined;
  /** `timelineRead` 端口是否注入。 */
  readPortInjected: boolean;
}

/** 订阅裁决的错误码：三个都是协议里已有的稳定码，不新增同义码。 */
export type TimelineSubscribeRejectCode =
  | 'session_frozen_readonly'
  | 'timeline_unavailable'
  | 'invalid_params';

/**
 * 订阅时「这一趟读哪个源」的裁决（**纯函数**，由调用方负责那次 `lookup`）。
 *
 * 判据顺序即优先级，每条都有明确理由：
 * 1. 没给 `after_timeline_seq` ⇒ 老订阅（`legacy`）：老客户端连这个参数名都不知道。
 * 2. `read_from = 'legacy'` ⇒ 老订阅：回退开关的全部意义就是「不读新源」，
 *    此时连 `after_timeline_seq` 一起忽略（hello 里会标 `timeline_source: 'legacy'`，
 *    新客户端据此退回老行为，不是静默错配）。
 * 3. 同时给了 `since` ⇒ `invalid_params`：两套编号（进程级 hub seq / 会话 timeline_seq）
 *    混在一个游标里就是 ADR-105 §9 R7 拒绝的那件事。
 * 4. 没有 `session_id` ⇒ `invalid_params`：`timeline_seq` 是**会话内**序号，跨会话不可比
 *    （ADR-105 §10 第 1 项），拿不到会话就没有可核对的区间。
 * 5. `timelineHeads` 端口没注入 ⇒ `timeline_unavailable`：装配层把 timeline 读面整个关掉了，
 *    这不是「会话被冻结」，不许报成 `session_frozen_readonly`（那是会误导排障的假事实）。
 * 6. 端口在、`lookup` 返回 `undefined` ⇒ `session_frozen_readonly`：**旧格式会话**
 *    （有旧日志、没有任何 timeline 标记）只能只读冻结（ADR-105 D4）。这正是 A8② 的缺口：
 *    今天这个码只在写者打开时抛（`packages/core/src/timeline/writer.ts:386-391`）。
 * 7. `timelineRead` 端口没注入 ⇒ `timeline_unavailable`：能算区间却没有页读路径。
 *    **不**回落到环形缓冲——那会让帧带另一套 seq，客户端四条校验必然全红。
 */
export function decideTimelineSubscribe(input: TimelineSubscribeInput): TimelineSubscribeDecision {
  if (input.afterTimelineSeq === undefined) return { kind: 'legacy' };
  if (input.readFrom === 'legacy') return { kind: 'legacy' };
  if (input.sinceGiven) {
    return {
      kind: 'reject',
      code: 'invalid_params',
      message: '时间线订阅不接受 since：用 after_timeline_seq（排他游标），两套编号不得混用',
    };
  }
  if (input.sessionId === undefined || input.sessionId === '') {
    return {
      kind: 'reject',
      code: 'invalid_params',
      message: 'after_timeline_seq 是会话内序号：必须同时给 session_id',
    };
  }
  if (!input.headsInjected) {
    return {
      kind: 'reject',
      code: 'timeline_unavailable',
      message: '服务端未装配 timeline 读面（timelineHeads 端口缺失），无法声明时间线区间',
    };
  }
  if (input.heads === undefined) {
    return {
      kind: 'reject',
      code: 'session_frozen_readonly',
      message: `会话 ${input.sessionId} 没有 timeline（旧格式会话只读冻结，不迁移）：不能按 after_timeline_seq 订阅`,
    };
  }
  if (!input.readPortInjected) {
    return {
      kind: 'reject',
      code: 'timeline_unavailable',
      message: '服务端未装配 timeline 分页读端口（timelineRead 端口缺失）：拒绝回落到环形 seq',
    };
  }
  return { kind: 'timeline', heads: input.heads };
}

/** 订阅裁决结果（三种，互斥）。 */
export type TimelineSubscribeDecision =
  | { kind: 'legacy' }
  | { kind: 'timeline'; heads: TimelineHeadsLike }
  | { kind: 'reject'; code: TimelineSubscribeRejectCode; message: string };
