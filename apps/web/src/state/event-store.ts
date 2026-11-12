/**
 * 有界事件缓冲（ring buffer）+ 订阅。
 *
 * - 每个 run 最多 5000 条，总数最多 20000 条；超出丢弃最旧并标记 truncated
 *   （口径与依据见下面两个常量的注释：条目数 ≈ 工具调用数 × 5~6，不是 token 数）。
 * - 按 seq 去重（重连回放不会产生重复卡片）。
 * - 通知节流到 ~50ms，避免每个 token 重渲染整棵树。
 * - 快照对象在通知时整体替换，`entries` 也必须是新数组：消费者（ChatView / RunDetail）
 *   用 `useMemo(..., [snapshot.entries])` 派生视图，复用可变数组会让流式事件不触发重算，
 *   表现为“必须刷新才看到内容”。
 * - **锚点事件不参与按 run 裁剪**：`run.started` / `user.message` / 终态事件承载
 *   `session_id`、`input`、`status`，裁掉就会让整段 live run 从会话时间线消失（见
 *   `RUN_ANCHOR_EVENT_TYPES`）。`session_id` 另外按 run 记住，裁剪后仍能归属会话。
 * - **回填暂存**（`beginBackfill` / `endBackfill`）：有界回放的窗口只有最新 1 MiB /
 *   2000 条，更早那一段要由客户端带 `until_seq` 逐页拉回；页是「新→旧」到达的，而
 *   这里的时间线只接受递增 seq。所以回填期间帧先攒在暂存区，拉完再按 seq 升序一次性
 *   经 `push()` 并入 —— 去重与增量合并始终只有这一条路径。
 * - **存储层不做任何跨事件合并**（逐 delta 原样进环，seq 即真相）：
 *   合并曾把相邻同 kind 的增量并进上一条并只留**首 seq**，于是 `truncateAfter` 按条目
 *   seq 判去留、重放时又把尾巴并进同一条目 —— 用户看到「结尾正文重复」。
 *   现在「每个 seq 可见」是硬不变量（见 `docs/dev/reports/run-tail-duplicate/REPORT.md`）；
 *   段内合并发生在**读侧**（`events.ts` 的 fold 累积 `buf`），item 身份锚定首 delta 的 seq。
 * - **不产时间线产物的流式增量不进缓冲**（`tool_call_delta` / `finish` / 未识别的
 *   chunk 子类型，判据见 `events.ts#producesTimelineItem`）：它们一条都不产 item，
 *   却按 delta 计占 per-run 额度 —— 实测一个 run 6.1 万条 `tool_call_delta`，
 *   约 14 次工具调用就把 2000 条额度填满，随后真正产卡的条目被逐条挤出去。
 */
import type { RunEvent } from '../gateway/types';
import { producesTimelineItem, type StoredEvent } from './events';

/**
 * 每个 run 在客户端缓冲里保留的条目上限。
 *
 * 口径（2026-11 实测，见 `packages/.../`.scratch/run-event-eviction 报告）：一次工具调用
 * = 一次完整 LLM 往返 = 至少 5 条事件（tool.call.started / llm.request / llm.response /
 * llm.stream.summary / tool.call.completed），再加上 hook 对、run.checkpoint、
 * context.changed 等每轮固定开销。所以「工具调用数 × 5~6」就是条目数的量级。
 *
 * 2000 条 ≈ 300~400 次工具调用 —— 对「跑十分钟的多工具 run」只是勉强够。0.53 起抬到
 * 5000（≈ 800~1000 次工具调用），代价是缓冲内存上界从 ~1.2 MB 抬到 ~3 MB（实测条目
 * 均值约 600 B），flush 浅拷贝在 20 Hz 下仍是亚毫秒级。
 *
 * 注意：**不产 timeline item 的增量**（`tool_call_delta` / `finish`）根本不进缓冲
 * （`producesTimelineItem`，见 `push`）。所以这个上限量的是「真实事件条数」，
 * 不是「token 数」。
 *
 * 0.53 起文本 / 思考的流式增量**也按 delta 计数**（存储层不再合并）：delta 洪水
 * （一个 run 曾 6.1 万条）会把环挤到只剩尾部。这只影响**传输面**——运行详情实时日志
 * 少几行、`hasNewestRunStart` 偶尔多拉 1~2 页；渲染侧的 item 由 `LiveItemStore` 物化，
 * 裁剪不影响屏上内容（DESIGN.md I4）。要合并必须做成「片段级 seq 集合可见」，
 * 见 REPORT §7 的 `fragSeqs`。
 */
export const MAX_EVENTS_PER_RUN = 5000;
/**
 * 缓冲总量上限（跨 run 的安全网）。
 *
 * 客户端是**按订阅范围**收事件的（Chat 只收当前会话、Runs 只收 `run.*`、run 详情只收
 * 单个 run；换范围时 `clear()`），所以这个数正常情况下摸不到 —— 它只是防止某个
 * 订阅范围异常宽时把内存吃爆。与 `MAX_EVENTS_PER_RUN` 同比抬高（10000 → 20000），
 * 保证「两个满额 run」不会被总量闸门提前裁掉。
 */
export const MAX_EVENTS_TOTAL = 20000;
export const NOTIFY_INTERVAL_MS = 50;

/**
 * 单 run 裁剪时必须保留的锚点事件。
 *
 * 流式增量（`llm.stream.chunk`）按 delta 计，一条长正文就能把同一个 run 的 2000 条
 * 额度吃满；老实现从 run 头部逐条丢，`run.started` 一旦被丢：
 * `group.sessionId` 变 undefined → 会话窗口按 sessionId 过滤时整段 live run 消失，
 * 用户表现为「跑的时候看不见正文/工具卡，run 结束刷新后才一次性出现」。
 * 这里只丢非锚点条目，并保留 run 首尾的语义事件。
 */
export const RUN_ANCHOR_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'user.message',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** run 的起点事件：回填是否已经接上「这一轮的开头」按它判。 */
function isRunHeadEvent(type: string): boolean {
  return type === 'run.started' || type === 'user.message';
}

export interface EventMeta {
  seq: number;
  jobId?: string;
}

/** 回填暂存的一帧（见 `EventStore#beginBackfill`）。 */
interface HeldEvent {
  event: RunEvent;
  meta: EventMeta;
}

export interface EventStoreSnapshot {
  entries: readonly StoredEvent[];
  /** 累计被裁剪过的 run（自首次 flush 起）。 */
  truncatedRuns: ReadonlySet<string>;
  /**
   * 自上一次快照以来被裁剪过的 run。
   *
   * @deprecated 渲染侧的 `EventGroupCache` 已不再是输入源（改为 `LiveItemStore` 物化 item），
   * 裁剪**不再**需要通知渲染重算（I4 / I6）。字段暂留：`check-transcript-items` 的旧
   * fixture 仍按它签名对拍，等它们整体迁到 `check-live-items` 后一起删。
   */
  truncatedSince: ReadonlySet<string>;
  /** 最近一次通知时的 seq；重连/hello 判断用。 */
  lastSeq: number;
  version: number;
}

/** 传输面的可注入上限（**只给门禁 / 测试**用，生产走默认常量）。 */
export interface EventStoreOptions {
  /** 每个 run 的条目上限（默认 `MAX_EVENTS_PER_RUN`）。 */
  maxEventsPerRun?: number;
  /** 总条目上限（默认 `MAX_EVENTS_TOTAL`）。 */
  maxEventsTotal?: number;
}

/** 事件自报的 session 归属：优先顶层字段，其次 `data.session_id`；缺失时 undefined。 */
function eventSessionId(event: RunEvent): string | undefined {
  const topLevel = (event as { session_id?: unknown }).session_id;
  if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel;
  const value = (event.data as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function emptySnapshot(): EventStoreSnapshot {
  return {
    entries: [],
    truncatedRuns: new Set(),
    truncatedSince: new Set(),
    lastSeq: 0,
    version: 0,
  };
}

export class EventStore {
  private entries: StoredEvent[] = [];
  private runCounts = new Map<string, number>();
  /** run_id → session_id：裁剪掉 `run.started` 后仍能把事件归属到会话。 */
  private runSessions = new Map<string, string>();
  /**
   * 当前事件订阅范围所属的会话（服务端按 `session_id` 过滤时为该会话 id）。
   *
   * **为什么需要**：`packages/serve/src/gateway.ts` 的会话订阅是「按 session_id
   * **过滤**」而不是「给事件**盖**章」——`eventSessionId()` 只读 `data.session_id`，
   * 缺省时靠服务端 `runSessions` LRU 命中决定发不发，命中结果不上 wire。而
   * `llm.stream.chunk` / `tool.call.*` 天生不带 `session_id`；再加上有界回放（最新
   * 1 MiB / 2000 条）可能把 `run.started` 挡在窗口外，客户端的分组就会拿不到
   * sessionId，被 `useChatTranscript` 的会话窗口整段过滤（用户看到「运行中什么都没
   * 有，跑完刷新才出现」）。
   *
   * **不变量**：
   * - 只是 fallback：`push()` 的归属优先级恒为「事件自报 `session_id` >
   *   runSessions 映射 > scopeSession」，已有显式值的条目绝不被作用域覆盖；
   * - 只由 `SubscriptionController` 在**服务端过滤生效的会话订阅**下设置，其它范围
   *   （run / runs / team / none）与旧 gateway 降级路径都**显式置为 undefined**；
   * - `reset()` 保留该值（gap reset 后仍处于同一会话订阅），但订阅范围一旦变化必须
   *   由 `setScopeSession` 立刻覆写——归属来源变了就要重算，见
   *   `serverScopedSessionId()`。
   *
   * 背景见 L-041「事件缓冲不是历史」：缓冲里的条目只是某次订阅的增量快照，不能靠
   * “谁最后写的”推断归属，必须有显式、可清除的作用域。
   */
  private scopeSession: string | undefined;
  /** 回填暂存区（见 `beginBackfill`）；非空期间 `push` 只入暂存，不动时间线。 */
  private held: HeldEvent[] = [];
  /** 回填游标地板；非 null = 正在回填。 */
  private holdFloor: number | null = null;
  private truncated = new Set<string>();
  /** 待发布到下一份快照的裁剪增量；flush 后清空。 */
  private truncatedSince = new Set<string>();
  /**
   * 累计被当作「传输噪声」丢掉的流式增量条数（判据 `events.ts#producesTimelineItem`
   * 为 false 的那些）。只为可观测：提示卡那一单要显示「本轮有 N 条事件未在实时视图
   * 里出现」，先只暴露 getter，**不在 UI 里渲染**。
   *
   * **不参与** `truncated*` 语义（那两个是已弃用的渲染信号，见 `EventStoreSnapshot`）；
   * 这里丢的东西不产 item，不该触发「本轮被裁剪」的提示。
   */
  private droppedNoiseCount = 0;
  private lastSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: EventStoreSnapshot = emptySnapshot();
  /** 本 run 的条目上限（注入点见 `EventStoreOptions`，默认 `MAX_EVENTS_PER_RUN`）。 */
  private readonly maxEventsPerRun: number;
  /** 总条目上限（默认 `MAX_EVENTS_TOTAL`）。 */
  private readonly maxEventsTotal: number;

  constructor(
    private readonly notifyDelayMs = NOTIFY_INTERVAL_MS,
    options: EventStoreOptions = {},
  ) {
    this.maxEventsPerRun = options.maxEventsPerRun ?? MAX_EVENTS_PER_RUN;
    this.maxEventsTotal = options.maxEventsTotal ?? MAX_EVENTS_TOTAL;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EventStoreSnapshot => this.snapshot;

  /** 当前已接收的最大 seq（不等待 50ms 合批）。 */
  get currentSeq(): number {
    return this.lastSeq;
  }

  /**
   * 累计被丢掉的传输噪声条数（本 store 实例生命周期内的累加值）。
   *
   * 口径见 `droppedNoiseCount`：这些条目本来就不产时间线物品，丢它们对可见内容零影响。
   * 只读、不进快照（避免为一个观测数字让每个 50ms 合批都换一次 snapshot 对象）。
   */
  get droppedNoise(): number {
    return this.droppedNoiseCount;
  }

  /**
   * 设置「订阅范围内的会话」。**必须显式传值**（含 `undefined`）：
   * 换会话要立刻覆写，换到 run / runs / team / none 范围要立刻清空 ——
   * 「不设」会保留上一个会话的残留作用域，把别的会话的增量误归属过来（串台）。
   *
   * 只影响**之后** push 的条目；已在缓冲里的条目保留 push 时的归属，不回写。
   * 归属来源变了就要重算，调用方见 `gateway/subscription.ts#serverScopedSessionId`。
   */
  setScopeSession(sessionId: string | undefined): void {
    if (this.scopeSession === sessionId) return;
    this.scopeSession = sessionId;
  }

  /**
   * 写入一条事件；seq 不大于已见值时忽略（回放去重）。返回是否实际写入。
   *
   * 存储层**不合并任何事件**（逐 delta 原样进环）：合并会让条目 seq 与内容范围脱钩，
   * 而 `truncateAfter` 按条目 seq 判去留 —— 重放时边界落在合并条目内部就是「结尾正文
   * 重复」的根因（REPORT §0.1）。段内合并只在读侧做（`events.ts` 的 fold 累积 `buf`）。
   */
  push(event: RunEvent, meta: EventMeta): boolean {
    if (!Number.isFinite(meta.seq)) return false;
    if (this.holdFloor !== null) {
      // 回填期间：更早的分段还在路上，先按到达顺序攒着（`endBackfill` 会按 seq 升序
      // 重新送进这条路径）。落在地板或更旧的帧属于回填页的职责，这里不重复收。
      if (meta.seq <= this.holdFloor) return false;
      this.held.push({ event, meta: { ...meta } });
      return true;
    }
    if (meta.seq <= this.lastSeq) return false;
    // **不产时间线产物的流式增量不进缓冲**（判据唯一来源见 `events.ts#producesTimelineItem`：
    // `buildGroup` 的 chunk 分支只认 text/reasoning，`tool_call_delta` 什么都不做、
    // `finish` 只收口边界）。
    //
    // 丢它们安全：既不产 item，也不是内容权威 —— 正文/思考是 text/reasoning 增量合并出来的，
    // 工具卡与结果由 `tool.call.*` 给，完整回答与用量由 `llm.response` 与磁盘事件日志给。
    // 代价只有一条：运行详情的实时事件流（`useRunTrace` 的 live 部分）里少几行传输噪声。
    // 收益是把「per-run 额度按 delta 计」这件事从根上去掉（实测 61 081 条 tool_call_delta
    // 的 run，此前约 14 次工具调用就把 2000 条额度填满）。
    if (!producesTimelineItem(event)) {
      // 游标照推：这些 seq 已经「见过」，重连回放不该再讨一遍；快照不必发布（屏上没变化）。
      this.lastSeq = meta.seq;
      this.droppedNoiseCount += 1;
      return true;
    }
    this.lastSeq = meta.seq;
    const runId = event.run_id;
    // 归属会话的字段最先记住：即使本 run 的 `run.started` 之后被裁掉，仍能归属会话。
    const sessionId = eventSessionId(event);
    if (sessionId !== undefined) this.runSessions.set(runId, sessionId);
    // 归属优先级**恒为**：事件自报 `session_id` > runSessions 映射（同样来自自报）>
    // 当前订阅作用域。scopeSession 只是 fallback —— 事件一旦自带显式归属，绝不被
    // 作用域覆盖（否则切会话的窗口期内会把旧会话事件改判给新会话）。
    // 作用域兜的是「有界回放把 run.started 挡在窗口外」的增量：流式 delta 与工具事件
    // 本身没有 session_id，只能靠订阅范围归属。
    const owner = this.runSessions.get(runId) ?? this.scopeSession;
    this.entries.push({
      event,
      seq: meta.seq,
      ...(owner !== undefined ? { sessionId: owner } : {}),
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
    });
    const count = (this.runCounts.get(runId) ?? 0) + 1;
    this.runCounts.set(runId, count);

    // 每 run 上限：丢该 run 最旧的**非锚点**条目（锚点见 `RUN_ANCHOR_EVENT_TYPES`）。
    // 裁剪只影响传输面：屏上的 item 由 `LiveItemStore` 物化，不随环缩水（I4）。
    if (count > this.maxEventsPerRun) {
      const index = this.oldestEvictableIndex(runId);
      if (index >= 0) this.entries.splice(index, 1);
      this.runCounts.set(runId, count - 1);
      this.truncated.add(runId);
      this.truncatedSince.add(runId);
    }

    // 总上限：从最旧开始丢。
    while (this.entries.length > this.maxEventsTotal) {
      const removed = this.entries.shift();
      if (!removed) break;
      const removedRun = removed.event.run_id;
      const remaining = (this.runCounts.get(removedRun) ?? 1) - 1;
      if (remaining <= 0) this.runCounts.delete(removedRun);
      else this.runCounts.set(removedRun, remaining);
      this.truncated.add(removedRun);
      this.truncatedSince.add(removedRun);
    }

    this.scheduleNotify();
    return true;
  }

  /**
   * 删除某个会话的全部事件（rewind 后这些历史已不存在）。
   *
   * 归属判定：事件顶层 / `data.session_id` 等于目标会话的 run 记为目标的 run；该 run
   * 中未带 session_id 的条目一并删除。先按 session 判定而不是直接按 run_id，
   * 避免 `session.rewound` 共用 `run_id: 'manual'` 时误删其它会话的条目。
   * 删除后重建 run 计数，并把受影响的 run 写进 `truncatedSince`（已弃用的渲染信号，
   * 见 `EventStoreSnapshot`），同时把「语义删除」转发给物化面：rewind 之后历史真的
   * 不存在了，item 必须跟着删（这与缓冲裁剪不同 —— 裁剪删的是传输窗口，I4/I6）。
   * 立即发布快照。返回删除的条目数。
   */
  dropSession(sessionId: string): number {
    const runIds = new Set<string>();
    for (const entry of this.entries) {
      if (this.ownerOf(entry) === sessionId) runIds.add(entry.event.run_id);
    }
    // 回填暂存里也可能有该会话的帧（帧先到、会话后撤回）：同一判定过滤掉。
    const heldBefore = this.held.length;
    if (heldBefore > 0) {
      this.held = this.held.filter((item) => {
        const owner = eventSessionId(item.event) ?? this.scopeSession;
        return !(owner === sessionId || (owner === undefined && runIds.has(item.event.run_id)));
      });
    }
    if (runIds.size === 0) return heldBefore - this.held.length;

    const before = this.entries.length;
    const removedRunIds = new Set<string>();
    this.entries = this.entries.filter((entry) => {
      const owner = this.ownerOf(entry);
      const remove = owner === sessionId || (owner === undefined && runIds.has(entry.event.run_id));
      if (remove) removedRunIds.add(entry.event.run_id);
      return !remove;
    });
    const removed = before - this.entries.length;
    if (removed === 0) return 0;

    this.runCounts.clear();
    for (const entry of this.entries) {
      const runId = entry.event.run_id;
      this.runCounts.set(runId, (this.runCounts.get(runId) ?? 0) + 1);
    }
    for (const runId of removedRunIds) {
      // 局部重建信号：bucket 里可能还留着被删条目的旧副本。
      this.truncatedSince.add(runId);
      // 已没有条目的 run 不再需要累计“被裁剪”标记。
      if (!this.runCounts.has(runId)) {
        this.truncated.delete(runId);
        this.runSessions.delete(runId);
      }
    }
    this.flush();
    return removed;
  }

  /**
   * 截断到 `nextSeq`：**保留** `seq <= nextSeq` 的条目，丢弃更新的。
   *
   * 用于 hello / gap 的「重新对齐游标」：有界回放会把窗口内的条目重新 `push` 上来，
   * `push` 的 `seq <= lastSeq` 去重保证幂等，所以**不需要先清空**。先清空会让整条
   * 时间线消失一帧再填回（用户看到的就是整页闪烁 + 滚动位置丢失 + 跳到底部）。
   *
   * 只在**同一订阅作用域内**调用；作用域真的变了（换会话 / 换 Team / chat→Runs）
   * 必须用 `clear()`，否则旧范围的条目会留在屏上串台。
   *
   * 同步维护派生状态：条目变了就重建 `runCounts` / `runSessions`（不能留下已无条目
   * 的 run 的过期映射），并把被丢弃条目的 run 记进 `truncatedSince`（已弃用的渲染信号）。
   * **这是传输面操作，不动 item**（I6）：回放靠 `push` 的 seq 去重 + 物化面的水位幂等，
   * 所以这里既不需要、也**不许**触发整表重算。
   * `scopeSession` 不变（同一作用域不变量）。
   *
   * **回填期间是空操作**：那段时间游标由 `beginBackfill` / `endBackfill` 管理，
   * 外侧的 hello / gap 截断会把暂存帧的落点踩坏（更早的分页还没到）。
   */
  truncateAfter(nextSeq: number): number {
    if (this.holdFloor !== null) return 0;
    // entries 按 seq 升序：二分出第一条 seq > nextSeq。
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.entries[mid]?.seq ?? 0) <= nextSeq) low = mid + 1;
      else high = mid;
    }
    const dropped = this.entries.slice(low);
    this.lastSeq = nextSeq;
    if (dropped.length === 0) {
      // 只推进了游标（没有尾部要丢）：仍然发布一次，保证快照里的 lastSeq 与内部一致。
      this.flush();
      return 0;
    }

    this.entries = this.entries.slice(0, low);
    this.runCounts.clear();
    this.runSessions.clear();
    for (const entry of this.entries) {
      const runId = entry.event.run_id;
      this.runCounts.set(runId, (this.runCounts.get(runId) ?? 0) + 1);
      const owner = entry.sessionId ?? eventSessionId(entry.event);
      if (owner !== undefined) this.runSessions.set(runId, owner);
    }
    for (const entry of dropped) {
      const runId = entry.event.run_id;
      this.truncatedSince.add(runId);
      // 整个 run 的条目都没了：不再需要累计「被裁剪」标记。
      if (!this.runCounts.has(runId)) this.truncated.delete(runId);
    }
    this.flush();
    return dropped.length;
  }

  /**
   * 断线重连 / 刷新后的**回填暂存**：把游标退到 `floorSeq`（本轮订阅的 `since`，
   * 丢掉那些会被更早分页重新送达的尾部），之后到达的帧先攒起来。
   *
   * 为什么必须暂存：有界回放只给最新 1 MiB / 2000 条，更早的那一段要由客户端带
   * `until_seq` 逐页拉回；页是「新→旧」到达的，而这里的时间线只接受递增 seq。
   * 攒完再一次性按 seq 升序并入 `push()`，去重与增量合并仍然只有这一条路径
   * （不新增第二套合并，也不做乱序插入）。
   *
   * 期间 `truncateAfter` 是空操作：游标只由本方法与 `endBackfill` 推进。
   */
  beginBackfill(floorSeq: number): void {
    this.truncateAfter(floorSeq);
    this.held = [];
    this.holdFloor = floorSeq;
  }

  /**
   * 结束回填暂存：把攒下的帧按 seq 升序经 `push()` 并入（重复 seq 自然被忽略），
   * 时间线从地板一路接到最新，中间不留空洞。
   */
  endBackfill(): void {
    if (this.holdFloor === null) return;
    this.holdFloor = null;
    const held = this.held;
    this.held = [];
    if (held.length === 0) return;
    held.sort((a, b) => a.meta.seq - b.meta.seq);
    for (const item of held) this.push(item.event, item.meta);
  }

  /** 是否正处于回填暂存（分段拉取）期间。 */
  get backfilling(): boolean {
    return this.holdFloor !== null;
  }

  /**
   * 回填终止判定：**最新一条事件所属 run** 的起点（`run.started`）是否已经在缓冲里
   * （含回填暂存）。
   *
   * 历史由 `sessions.get` 提供，而它在 run 开始时就把本轮的用户消息写进了
   * `SessionState.messages`；所以刷新后唯一缺的就是「当前 run 的开头」。拿到它的
   * `run.started` 就说明重放已经接上历史，不必再往更早的分页拉。
   *
   * 传 `sessionId` 时只看该会话的条目：多会话节点上别的会话也在跑，不能拿它的 run
   * 当判据（否则会跳过本会话真正缺的那一段）。
   */
  hasNewestRunStart(sessionId?: string): boolean {
    const sameSession = (owner: string | undefined): boolean =>
      sessionId === undefined || owner === sessionId;
    let newestSeq = -1;
    let newestRun = '';
    for (const entry of this.entries) {
      if (entry.seq <= newestSeq) continue;
      if (!sameSession(this.ownerOf(entry))) continue;
      newestSeq = entry.seq;
      newestRun = entry.event.run_id;
    }
    for (const item of this.held) {
      if (item.meta.seq <= newestSeq) continue;
      if (!sameSession(eventSessionId(item.event) ?? this.scopeSession)) continue;
      newestSeq = item.meta.seq;
      newestRun = item.event.run_id;
    }
    if (newestRun === '') return false;
    for (const entry of this.entries) {
      if (entry.event.run_id !== newestRun) continue;
      if (isRunHeadEvent(entry.event.type)) return true;
    }
    for (const item of this.held) {
      if (item.event.run_id !== newestRun) continue;
      if (isRunHeadEvent(item.event.type)) return true;
    }
    return false;
  }

  /**
   * 真清空缓冲（换节点 / 断开连接 / 订阅作用域变化 / gateway 重启）。
   *
   * **不变量**：`scopeSession` 不随 clear 变化 —— 作用域由 `setScopeSession()` 负责，
   * 清空只处理条目。`runSessions`（run→session 自报映射）清空：它只是当前缓冲窗口的
   * 派生数据，重新回放/接收时重建；作用域不依赖它。
   * 回填暂存一并丢弃（作用域都变了，更早的分页也没有意义）。
   */
  clear(nextSeq = 0): void {
    this.entries = [];
    this.held = [];
    this.holdFloor = null;
    this.runCounts.clear();
    this.runSessions.clear();
    this.truncated.clear();
    this.truncatedSince.clear();
    this.lastSeq = nextSeq;
    this.version += 1;
    this.snapshot = {
      entries: [],
      truncatedRuns: new Set(),
      truncatedSince: new Set(),
      lastSeq: nextSeq,
      version: this.version,
    };
    this.cancelTimer();
    this.notify();
  }

  /** 立即发布待处理事件（测试与路由切换前使用）。 */
  flush(): void {
    this.cancelTimer();
    this.version += 1;
    this.snapshot = {
      // 复制数组：entries 在 push 中原地追加，复用引用会让 memo 消费者永远看到旧视图。
      entries: [...this.entries],
      truncatedRuns: new Set(this.truncated),
      truncatedSince: new Set(this.truncatedSince),
      lastSeq: this.lastSeq,
      version: this.version,
    };
    // 增量只对下一份快照有效；消费后即使没有新事件也不重复报告。
    this.truncatedSince.clear();
    this.notify();
  }

  destroy(): void {
    this.cancelTimer();
    this.held = [];
    this.holdFloor = null;
    this.listeners.clear();
  }

  /** 条目归属的会话：push 时记住的 run→session 优先，其次事件自报的字段。 */
  private ownerOf(entry: StoredEvent): string | undefined {
    return entry.sessionId ?? eventSessionId(entry.event);
  }

  /**
   * 该 run 最旧的**可裁剪**条目下标（锚点永不裁；整个 run 只剩锚点时退回最旧一条）。
   *
   * 旧实现分两档（先丢「时间线上不产产物」的条目、再丢内容条目）。那两档现在没有意义：
   * 唯一不产产物的大户（`tool_call_delta` / `finish`）在 `push()` 里根本不进环，
   * 剩下的条目在 fold 里都有产物 —— 而**裁剪已经不影响渲染**（I4），口径统一成
   * 「该 run 最旧的非锚点条目」。
   *
   * 没有任何条目时返回 -1。
   */
  private oldestEvictableIndex(runId: string): number {
    let oldestAny = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.event.run_id !== runId) continue;
      if (oldestAny < 0) oldestAny = index;
      if (RUN_ANCHOR_EVENT_TYPES.has(entry.event.type)) continue;
      return index;
    }
    return oldestAny;
  }

  private scheduleNotify(): void {
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.flush();
    }, this.notifyDelayMs);
  }

  private cancelTimer(): void {
    if (this.notifyTimer === undefined) return;
    clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
