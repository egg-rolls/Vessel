/**
 * 有界事件缓冲（ring buffer）+ 订阅。
 *
 * - 每个 run 最多 2000 条，总数最多 10000 条；超出丢弃最旧并标记 truncated。
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
 */
import type { RunEvent } from '../gateway/types';
import type { StoredEvent } from './events';

export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_EVENTS_TOTAL = 10000;
export const NOTIFY_INTERVAL_MS = 50;
/**
 * 单条合并后的增量上限（字符）。超过就另起一条，避免一条条目无限变长
 * （一个超长正文段会退化成多条条目，但仍远少于逐 delta 计数）。
 */
export const MAX_COALESCED_DELTA_CHARS = 16_384;

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
  /** 自上一次快照以来被裁剪过的 run；group-cache 用它做局部重建。 */
  truncatedSince: ReadonlySet<string>;
  /** 最近一次通知时的 seq；重连/hello 判断用。 */
  lastSeq: number;
  version: number;
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
  private lastSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: EventStoreSnapshot = emptySnapshot();

  constructor(private readonly notifyDelayMs = NOTIFY_INTERVAL_MS) {}

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
   * 写入一条事件；seq 不大于已见值时忽略（回放去重）。
   * 返回是否实际写入。
   */

  /**
   * 把相邻、同 run、同 kind 的流式增量并进上一条（返回 true = 已合并、不新增条目）。
   *
   * 只合并 `text_delta` / `reasoning_delta`，且要求**上一条就是**同 run 的同 kind 增量：
   * 一旦中间插入工具/事件/别的 run，就不再合并（保证 buildGroup 的 flush 边界不变）。
   * 合并后条目保持**首个 seq**，所以 text/reasoning 的段序 key 稳定；`lastSeq` 仍推进
   * 到最新，重连回放去重语义不变。gzip 不适用：这里只动内存条目。
   *
   * 原地更新（同一 key 的内容变长）要让 `EventGroupCache` 重建这一组 —— 复用
   * `truncatedSince` 通道（它本来就是「本组需要重算」的信号）。
   */
  private coalesceDelta(event: RunEvent, seq: number): boolean {
    if (event.type !== 'llm.stream.chunk') return false;
    const index = this.entries.length - 1;
    const last = this.entries[index];
    if (last === undefined || last.event.type !== 'llm.stream.chunk') return false;
    if (last.event.run_id !== event.run_id) return false;
    const prev = (last.event.data as { chunk?: { type?: string; delta?: string } }).chunk;
    const next = (event.data as { chunk?: { type?: string; delta?: string } }).chunk;
    if (prev === undefined || next === undefined) return false;
    if (prev.type !== next.type) return false;
    if (prev.type !== 'text_delta' && prev.type !== 'reasoning_delta') return false;
    if (typeof prev.delta !== 'string' || typeof next.delta !== 'string') return false;
    if (prev.delta.length + next.delta.length > MAX_COALESCED_DELTA_CHARS) return false;
    const merged: RunEvent = {
      ...last.event,
      data: {
        ...(last.event.data as Record<string, unknown>),
        chunk: { ...next, delta: prev.delta + next.delta },
      },
    };
    this.entries[index] = { ...last, event: merged };
    this.lastSeq = seq;
    this.truncatedSince.add(event.run_id);
    this.scheduleNotify();
    return true;
  }

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
    // 相邻同 kind 的流式增量先合并：per-run 上限按「段」计数，而不是按 delta 计数。
    // （真实 run 有 177 轮 / 70k completion tokens ≈ 数万 delta 事件，按 delta 计数时
    //  上限会把**最早**的 thinking 段整段挤出去 —— 思考过程「凭空消失」的根因。）
    if (this.coalesceDelta(event, meta.seq)) return true;
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

    // 每 run 上限：优先丢该 run 最旧的非锚点条目（锚点见 RUN_ANCHOR_EVENT_TYPES）。
    if (count > MAX_EVENTS_PER_RUN) {
      const index = this.oldestEvictableIndex(runId);
      if (index >= 0) this.entries.splice(index, 1);
      this.runCounts.set(runId, count - 1);
      this.truncated.add(runId);
      this.truncatedSince.add(runId);
    }

    // 总上限：从最旧开始丢。
    while (this.entries.length > MAX_EVENTS_TOTAL) {
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
   * 删除后重建 run 计数，并把受影响的 run 写进 `truncatedSince`：group-cache
   * 据此做局部重建，否则同一窗口内的 partial 更新可能留下幽灵分组。
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
   * 的 run 的过期映射），并把被丢弃条目的 run 记进 `truncatedSince` —— 末条 seq 回退
   * 会让 `EventGroupCache` 走整表重建，`truncatedSince` 保证局部重建路径同样不留
   * 陈旧 bucket（否则 bucket 里会留着被丢掉的尾部 item）。
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
   * 该 run 最旧的可裁剪条目下标。
   *
   * 优先返回非锚点条目；整段都是锚点时退回最旧一条（极小 run 不该卡死上限），
   * 没有任何条目时返回 -1。
   */
  private oldestEvictableIndex(runId: string): number {
    let fallback = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.event.run_id !== runId) continue;
      if (fallback < 0) fallback = index;
      if (!RUN_ANCHOR_EVENT_TYPES.has(entry.event.type)) return index;
    }
    return fallback;
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
