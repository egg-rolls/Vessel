/**
 * 路由级事件订阅控制器（CONTRACT-msg-system §4.1，S2 数据层）。
 *
 * 每个 node 只有一条 WS。路由切换时由本控制器发 `events.subscribe` 收敛过滤，
 * 不再靠「全量回放 + 浏览器开窗」。它不 import 任何 Chat / Team 组件；S3 在路由
 * 变化时调用 `apply(scope)`。
 *
 * epoch 区分：
 * - 连接级 hello（首连 / 重连）→ `ConnectionProvider` bump epoch 并刷新详情；
 * - 订阅级 hello（每次成功 subscribe 都由服务端先发）→ 只重置事件库，不 bump
 *   epoch，避免切换过滤时无谓重拉 session / team 详情。
 * - 回填页 hello（本控制器为补更早区间而发的 `until_seq` 订阅）→ 既不动游标也不
 *   bump epoch：它只把「更早那一段」送进来，不影响「最新的已经收到」这一事实。
 *
 * 控制器在发出 subscribe 请求时置 `pendingHello`；`connection-handlers` 在
 * `onHello` 里用 `consumeHello(info)` 区分这三种 hello。
 *
 * **回填（分段拉取）**：服务端单次回放有界（最新 1 MiB / 2000 条）。刷新 / 重连时
 * 一次 1–2 分钟的流式 run 就能产出几千条 `llm.stream.chunk`，尾部窗口只覆盖最后
 * 几十秒 —— 用户看到的就是「这一轮开头的思考 / 正文没了」。所以订阅 hello 一发现
 * 有缺口，就退游标 + 暂存帧（`EventStore#beginBackfill`），再带
 * `until_seq = 上一页首条 seq - 1` 逐页往更早拉，直到覆盖当前 run 的起点
 * （`EventStore#hasNewestRunStart`）或环里再没有更早的事件。
 *
 * **磁盘段（`D \ R`）**：环只是磁盘日志的滑动缓存，环回填的天花板是「环的最旧一条」——
 * 被淘汰掉的那一段（磁盘有、环没有）今天一条都拿不回来，这就是「刷新后这次 run 只剩
 * 几条」的结构性缺口。所以环回填**之后**再问一次磁盘（`sessions.events`，
 * 见 `gateway/disk-backfill.ts`）：
 * - 拉回来的是「日志尾部窗口」，扫过环窗口并与它重叠，重叠部分按跨源内容键去重
 *   （`state/disk-replay.ts`），所以不会重复、也不会 replace 环里已有的内容；
 * - 任何失败（旧 gateway 没有这个方法 / 报错 / 超时）一律 **fail-open**：不合并、
 *   不清空、不动游标，行为退回「只有环」的今天，并记一条可观测警告
 *   （`EventStore#diskBackfill.lastError`）；
 * - 页数有硬上限（`DISK_BACKFILL_MAX_PAGES`），超限告警而不无限翻页。
 *
 * 顺序为什么是「先环后磁盘」而不是并行：环回填期间 `EventStore` 处于暂存 + 冻结态
 * （`holdFloor`，`truncateAfter` 是空操作），此时往 `entries` 里插一批更早的条目会把
 * 暂存帧的落点踩坏。磁盘段并入本身不依赖环，但它必须发生在环的游标稳定之后。
 */

import { t } from '../i18n';
import type { ReplaySegment } from '../state/disk-replay';
import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';
import {
  GatewayReplaySource,
  newestRunIds,
  type ReplayEvent,
  type ReplaySink,
  recoverReplay,
} from './replay-source';
import type { HelloInfo } from './types';

/** 旧 gateway 不识别 `session_id`；用 feature 做版本协商，不用形状探测。 */
export const SESSION_FILTER_FEATURE = 'events.session-filter';

/** 旧 gateway 不识别 `until_seq`（分段回放）；同样走 feature 协商。 */
export const REPLAY_RANGE_FEATURE = 'events.replay-range';

/**
 * 回填页数上限。
 *
 * 上下界推导（改这个数之前请重算，别只改常量）：
 * - 单页条数由服务端回放预算决定：地板 2000 条 / 1 MiB（`replay-budget.ts` 的
 *   `MIN_EVENTS` / `MIN_BUDGET_BYTES`；范围内找不到 `run.started` / `user.message` 锚点
 *   时整段退化为地板预算，见那里的 `floorIndex < 0` 分支），天花板 50000 条 / 8 MiB。
 *   保守假设取地板：**单页至少 2000 条**。
 * - 环形缓冲容量 50000 条（`event-buffer.ts#DEFAULT_MAX_HISTORY`）。
 * - ⇒「走穿整个环」的保守上界 = ceil(50000 / 2000) = **25 页**；6 页只覆盖 12000 条，
 *   即环的 24%。
 * - 真实停止条件不是走穿环，而是「本 run 起点已经进来」（`hasNewestRunStart`），
 *   所以实际需要的是「本 run 起点 → 尾部」的条数：短 run 1–2 页够；单个长请求的
 *   chunk 峰值已到 11154 条（`docs/dev/handoff/chunk-loss-measurement.md`），多轮工具
 *   调用的 run 必然超过 6 页。
 *
 * 结论：`6` 是「环 = 10000 条」时代的遗留值（当时 6 × 2000 > 10000 才成立），
 * 0.53 把环与预算一起抬到 50000 后这里没跟着重算。上调属**行为变更**（更多 RPC 页、
 * 更长暂存窗口、`endBackfill` 更晚），需单独立项，不在文档单内改。
 */
const MAX_BACKFILL_PAGES = 6;

/** 路由 → 订阅范围的唯一映射（契约 §4.1 表格）。 */
export type SubscriptionScope =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'team' }
  | { kind: 'runs' }
  /** Runs 详情页：只看单个 run 的全部事件（llm / tool / run 生命周期）。 */
  | { kind: 'run'; runId: string }
  | { kind: 'none' };

export interface SubscriptionFilter {
  since: number;
  run_id?: string;
  session_id?: string;
  types?: string[];
}

export interface BuiltSubscription {
  filter: SubscriptionFilter;
  /**
   * feature gate 降级时（旧 gateway）UI 需要自行按会话过滤事件的 session id；
   * 服务端订阅只能退回 `since=currentSeq`。
   */
  clientSessionFilter?: string;
}

/**
 * 纯函数：把路由范围翻译成 `events.subscribe` 参数与（可选）客户端过滤归属。
 *
 * - Chat 且 gateway 支持 `events.session-filter` → `{session_id, since: 0}`，
 *   只回放本会话尾部窗口；正文另有 `sessions.get`。
 * - Chat 但旧 gateway → `{since: currentSeq}`，由 UI 过滤。
 * - Team → 只收 run/agent 失效信号，从当前 seq 起，不重放历史。
 * - Runs / Dashboard → `{types: ['run.*'], since: 0}`（有界回放）。
 * - 无明确范围 → 不重放。
 */
export function buildSubscription(
  scope: SubscriptionScope,
  opts: { currentSeq: number; sessionFilter: boolean },
): BuiltSubscription {
  switch (scope.kind) {
    case 'chat':
      if (opts.sessionFilter) {
        return { filter: { since: 0, session_id: scope.sessionId } };
      }
      return {
        filter: { since: opts.currentSeq },
        clientSessionFilter: scope.sessionId,
      };
    case 'team':
      return { filter: { since: opts.currentSeq, types: ['run.*', 'agent.*'] } };
    case 'runs':
      return { filter: { since: 0, types: ['run.*'] } };
    case 'run':
      // 详情页时间线要 llm / tool 事件，不能只收 run.*；按 run_id 收敛后回放有界。
      return { filter: { since: 0, run_id: scope.runId } };
    case 'none':
      return { filter: { since: opts.currentSeq } };
  }
}

/**
 * 本次订阅能否为事件「盖会话章」（`EventStore#scopeSession` 的取值）。
 *
 * 只在**服务端按 `session_id` 过滤**的 chat 订阅下返回会话 id：
 * - 服务端过滤时事件流里只剩该会话的增量，而 `llm.stream.chunk` / `tool.call.*`
 *   本身不带 `session_id`，有界回放（最新 1 MiB / 2000 条）还可能把 `run.started`
 *   挡在窗口外 —— 没有作用域归属，分组就永远拿不到 sessionId，被会话窗口整段过滤。
 * - 旧 gateway 降级（`clientSessionFilter` 有值）时事件是**未过滤**的，盖章会把别的
 *   会话的事件误归属，因此返回 undefined，由 UI 按事件自报的 session 过滤。
 * - `run` / `runs` / `team` / `none` 范围一律 undefined：它们不是会话订阅，
 *   而且必须是**显式清除**而不是「不设」，否则切走页面后残留作用域会造成串台。
 */
/**
 * 订阅「作用域身份」：只有范围和目标都相同才算同一作用域。
 *
 * 用途是决定重订阅要不要清空事件缓冲（EventStore#clear）：
 * - 会话 A 与会话 B 互不兼容（换会话必须清）；
 * - team / runs / none 各自独立（chat → runs 必须清）；
 * - run 详情只关心单个 run，换 run 也要清。
 * 同一个 key 的重复 apply（重连、gap 重对齐、feature gate 从降级升到服务端过滤）
 * 属于「同一作用域重新订阅」，内容原地保留 —— 这是消除整页闪烁的关键。
 */
export function scopeIdentity(scope: SubscriptionScope): string {
  switch (scope.kind) {
    case 'chat':
      return `chat:${scope.sessionId}`;
    case 'run':
      return `run:${scope.runId}`;
    default:
      return scope.kind;
  }
}

export function serverScopedSessionId(built: BuiltSubscription): string | undefined {
  if (built.clientSessionFilter !== undefined) return undefined;
  return built.filter.session_id;
}

export class SubscriptionController {
  /** 最近一次路由请求的订阅；重连后据此重新收敛。 */
  private desired: SubscriptionScope | null = null;
  /** 当前生效过滤的 key（JSON），用于跳过幂等重复订阅。 */
  private appliedKey: string | null = null;
  /** 上一次真正生效的订阅作用域（）；变化时才清空事件缓冲。 */
  private appliedScopeKey: string | null = null;
  /** 在途 subscribe：下一个 hello 属于订阅 epoch，还是回填页。 */
  private pendingHello: 'subscribe' | 'page' | null = null;
  /** 串行化订阅请求；期间的新 scope 合并到下一轮。 */
  private running: Promise<void> | null = null;
  private clientFilter: string | undefined;
  /** 最近一次真正发出去的订阅（回填复用它的 `since` / `session_id`）。 */
  private lastBuilt: BuiltSubscription | null = null;
  /** 回填中：待补区间上界（含）；非 null = 回填在跑。 */
  private backfillUpper: number | null = null;
  /**
   * 本轮的环回填判定发现过缺口（`startBackfill` 里和 `backfillUpper` 一起 arm）。
   *
   * 它决定**要不要再问一次磁盘**：只有「环确实接不上」的那一轮才值得拉
   * `sessions.events` —— 环完整时（短会话 / 刚刷新但环没淘汰）磁盘段只会是重复内容。
   */
  private diskPending = false;
  /** 磁盘段回填在跑（防重入：同一轮里 apply / 路由抖动都不该叠第二次）。 */
  private diskRunning = false;
  /**
   * 连接级 hello 时的服务端最新 seq。重连后自动重新收敛时用它作为
   * `since=currentSeq` 的锚点：连接级回放已经发生，Team / 无范围订阅不必再回放一遍。
   */
  private seqOverride: number | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly eventStore: EventStore,
    /**
     * 可读提示的出口（远程 / 截断时「少补了」必须说出来，不许静默）。
     * 缺省 = 不说话（仍进 `EventStore#diskBackfill`）。
     */
    private readonly notice?: (message: string) => void,
  ) {}

  /** 路由变化时调用；重复 scope 幂等（同一 filter 不重复发请求）。 */
  apply(scope: SubscriptionScope): Promise<void> {
    this.desired = scope;
    if (this.running !== null) return this.running;
    const promise = this.run();
    this.running = promise;
    // `run` 的同步阶段（幂等 / 无 desired）可能在赋值前就结束；统一在微任务里
    // 按 promise identity 清理，避免残留一个已解决的 running 吞掉后续 apply。
    void promise.then(
      () => {
        if (this.running === promise) this.running = null;
      },
      () => {
        if (this.running === promise) this.running = null;
      },
    );
    return promise;
  }

  /**
   * `onHello` 用：这个 hello 属于连接级、订阅 epoch，还是回填页？
   * 只会让**下一个** hello 命中；连接级 hello 不受影响。
   *
   * 订阅 epoch 若显示「有界回放只给到了尾部窗口」，这里顺手就开始回填
   * （`startBackfill`）：退游标 + 暂存帧，然后逐页把更早的区间拉回来。
   * 返回 'page' 时调用方**不得**改游标 —— 那一段的游标归回填管。
   */
  consumeHello(info: HelloInfo): 'connection' | 'subscribe' | 'page' {
    const pending = this.pendingHello;
    this.pendingHello = null;
    if (pending === null) return 'connection';
    if (pending === 'subscribe') this.startBackfill(info);
    return pending;
  }

  /**
   * 连接级 hello 之后：服务端连接已回到无过滤状态，按当前路由重新收敛。
   * 首次连接时 S3 可能还没设置路由，`desired` 为 null 就保持默认全量订阅。
   *
   * `latestSeq` 用于「不重放历史」的 scope（team / none）：连接级 hello 已经
   * 触发过有界回放，这里从服务端最新 seq 起订阅即可。
   */
  onConnectionHello(latestSeq?: number): void {
    this.appliedKey = null;
    this.pendingHello = null;
    const scope = this.desired;
    if (scope === null) {
      this.seqOverride = null;
      return;
    }
    this.seqOverride = typeof latestSeq === 'number' ? latestSeq : null;
    void this.apply(scope);
  }

  /** 断线：在途 hello 不可能到达；重连的 hello 会触发 `onConnectionHello`。 */
  onDisconnect(): void {
    this.pendingHello = null;
    this.appliedKey = null;
    //  故意保留：断线重连回到同一路由时不应清空缓冲（会整页闪）。
  }

  /** feature gate 降级时 UI 应过滤的 session id；服务端已过滤时为 undefined。 */
  get fallbackSessionId(): string | undefined {
    return this.clientFilter;
  }

  private supportsSessionFilter(): boolean {
    return this.client.protocol?.protocol.features.includes(SESSION_FILTER_FEATURE) ?? false;
  }

  private supportsReplayRange(): boolean {
    return this.client.protocol?.protocol.features.includes(REPLAY_RANGE_FEATURE) ?? false;
  }

  /**
   * 订阅 hello 之后的回填判定：尾部窗口没覆盖到 `since` 就说明中间缺了一段。
   *
   * 判定只用 hello 自带的 `from_seq`（本次实际会发送的第一条），不新增协议字段；
   * 缺口上界 = `from_seq - 1`。
   */
  private startBackfill(info: HelloInfo): void {
    const built = this.lastBuilt;
    if (built === null || this.backfillUpper !== null) return;
    // 只有「服务端按会话过滤」的 chat 订阅有「历史接管前缀」这层关系：其它范围本来
    // 就不回放历史（`since` 指向当前 seq），回填补不出东西。
    const sessionId = serverScopedSessionId(built);
    if (sessionId === undefined) return;
    // 当前 run 的起点已经在缓冲里（含从连接级回放拿到的那一段）：两种回填都不需要。
    // 这条判据同时覆盖「同一作用域重订阅 / 重连」的重复回填。
    if (this.eventStore.hasNewestRunStart(sessionId)) return;
    // 环没接到当前 run 的起点 ⇒ 磁盘段值得问一次。**与 `events.replay-range` 无关**：
    // 旧 gateway 连 `until_seq` 都没有时磁盘更是唯一来源（拿不到就 fail-open，见
    // `runReplayBackfill`）；进程重启后环整体为空（`from_seq` 可能 <= 1）时同理。
    this.diskPending = true;
    if (!this.supportsReplayRange()) return;
    const since = built.filter.since;
    const fromSeq = info.from_seq;
    // 环这一段已经追平（没有缺口）：只有磁盘段还要问（见上）。
    if (fromSeq <= since + 1) return;
    // 先退游标再暂存：`since` 之上刚刚收到的尾部会由分页重新送达，不能被当成「已有」。
    // 暂存必须在订阅 hello 的这一帧就开始，否则本页的帧会先被当成「已有」写进时间线。
    this.backfillUpper = fromSeq - 1;
    this.eventStore.beginBackfill(since);
  }

  /**
   * 逐页往回拉：每页带 `until_seq = 上一页首条 seq - 1`，落进暂存区，拉完一次性升序并入。
   *
   * 只在 `run()` 里调用（与实时订阅共用同一个发送方）：页订阅会重置服务端的实时过滤，
   * 但参数与本次订阅完全相同（同 `since` / `session_id`），所以不会串到别的会话。
   *
   * 停止条件（任一）：没有缺口了 / 当前 run 的起点已经进来（`hasNewestRunStart`，
   * 前面几轮由 `sessions.get` 接管） / 服务端在这一段里没有事件（环形缓冲已淘汰） /
   * 页数上限 / 路由变了。
   */
  private async runBackfill(scope: SubscriptionScope, built: BuiltSubscription): Promise<void> {
    const sessionId = serverScopedSessionId(built);
    const since = built.filter.since;
    const scopeKey = scopeIdentity(scope);
    const scopeChanged = (): boolean =>
      this.desired === null || scopeIdentity(this.desired) !== scopeKey;
    let next = this.backfillUpper ?? 0;
    try {
      for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
        if (sessionId === undefined || next <= since) break;
        // 本会话最新 run 的起点已经在缓冲/暂存里：更早的轮次交给 `sessions.get` 的历史。
        if (this.eventStore.hasNewestRunStart(sessionId)) break;
        this.pendingHello = 'page';
        let fromSeq: number | undefined;
        try {
          const res = await this.client.request<{ from_seq?: number }>('events.subscribe', {
            since,
            session_id: sessionId,
            until_seq: next,
          });
          fromSeq = typeof res?.from_seq === 'number' ? res.from_seq : undefined;
        } catch {
          // 旧 gateway（不认识 `until_seq`）或断线：保留已收到的部分，交给下一个 hello。
          break;
        } finally {
          if (this.pendingHello === 'page') this.pendingHello = null;
        }
        if (scopeChanged()) break;
        // 本页没有任何事件：环形缓冲已经淘汰到这一段之后，再往回也没有了。
        if (fromSeq === undefined || fromSeq > next) break;
        next = fromSeq - 1;
      }
    } finally {
      this.backfillUpper = null;
      // 无论如何都要撤销暂存：留着会让 `push()` 永远只写暂存区。
      // 作用域变了的那份内容由 `run()` 的 `clear()` 负责丢掉。
      this.eventStore.endBackfill();
    }
  }

  /**
   * 磁盘段回填（`D \ R`）：环的天花板是「环的最旧一条」，磁盘才有更早的那一段。
   *
   * 编排在 `gateway/replay-source.ts#recoverReplay`（阶段一 `sessions.events` + 阶段二
   * `events.list` 补 trace-only 类型），本方法只做三件本层才知道的事：
   * 1. **作用域守卫**：横跨多次 `await`，期间路由 / 会话可能已经变了 —— 变了就**不并入**
   *    （把 A 会话的磁盘事件并进 B 的缓冲 = 串台），已拉到的东西直接丢掉（下次回填还有）。
   * 2. **按段缓冲**：`apply()` 是逐页回调，每页都 `applyReplaySegment` 会触发一次整表
   *    重折叠；按段攒到段尾一次并入，页数就只是一次折叠的输入。
   * 3. **fail-open + 观测**：任何失败只进 `EventStore#diskBackfill`（attempts / lastError），
   *    不清空、不动游标、不抛。
   *
   * 只在 `run()` 里、**环回填之后**调用：环回填期间 `EventStore` 处于暂存 + 冻结态
   * （`holdFloor`），那时并入会让暂存帧的落点错位。
   */
  private async runReplayBackfill(
    scope: SubscriptionScope,
    built: BuiltSubscription,
  ): Promise<void> {
    const sessionId = serverScopedSessionId(built);
    if (sessionId === undefined || !this.diskPending) return;
    this.diskPending = false;
    if (this.diskRunning) return;
    this.diskRunning = true;
    const scopeKey = scopeIdentity(scope);
    const inScope = (): boolean =>
      this.desired !== null && scopeIdentity(this.desired) === scopeKey;
    let segment: ReplaySegment | null = 'session-log';
    const pending: ReplayEvent[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      // 作用域变了：这一批属于别的会话，不并入（会串台），也不记失败。
      const target = segment;
      if (!inScope() || target === null) return;
      this.eventStore.applyReplaySegment(target, batch, { sessionId });
    };
    const sink: ReplaySink = {
      apply: (events) => {
        // `segment === null` = 环段。Web 侧的环段在订阅帧到达时就已经 `push` 进
        // `EventStore`（`GatewayReplaySource#fetchRingSegment` 因此返回空），这里不再
        // 并入：环事件带的是 hub seq，落进磁盘负带会把两套 seq 混算。
        if (segment === null) return pending.length;
        pending.push(...events);
        return pending.length;
      },
      // 逐条警告都落到同一个可观测面：`lastError` 就是「这次没接上」的唯一信号。
      warn: (message) => this.eventStore.noteDiskBackfill({ error: message }),
      beginSegment: (next) => {
        flush();
        segment = next === 'ring' ? null : next;
      },
    };
    this.eventStore.beginDiskBackfillAttempt();
    try {
      const result = await recoverReplay(new GatewayReplaySource(this.client, sessionId), sink, {
        // 阶段二逐 run：只追最新几个 run（trace 只补它们的 trace-only 类型）。
        // **归属校验**：`runs` 只从**本会话的 session 日志**里取（`newestRunIds`），
        // 拿不到归属就不拉 —— 宁可不补，也不把别的会话的 run trace 拉进这个会话。
        runs: (events) => newestRunIds(events),
      });
      flush();
      this.eventStore.noteDiskBackfill({ truncated: result.truncated });
      // 降级必须可读（远程 / 截断 / 部分失败）：不许静默少补。
      if (result.sessionError !== undefined) {
        this.notice?.(t('replay.notice.failed'));
      } else if (result.truncated || result.traceRunsFetched.length < result.traceRunsRequested) {
        this.notice?.(
          t('replay.notice.partial', {
            runs: Math.max(1, result.traceRunsFetched.length),
            total: Math.max(1, result.traceRunsRequested),
          }),
        );
      }
    } catch (error) {
      // `recoverReplay` 自己逐段 fail-open，理论上到不了这里；留着是防「适配器自己炸」
      // 把订阅循环一起带走（那是 fail-closed，比「少一段」更坏）。
      this.eventStore.noteDiskBackfill({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.diskRunning = false;
    }
  }

  private async run(): Promise<void> {
    // 先让出一次微任务：保证 `apply` 里的 `this.running = promise` 一定发生在
    // 本次 run 可能同步结束之前。
    await Promise.resolve();
    for (;;) {
      const scope = this.desired;
      if (scope === null) return;
      const baseSeq = this.seqOverride ?? this.eventStore.currentSeq;
      this.seqOverride = null;
      const built = buildSubscription(scope, {
        currentSeq: baseSeq,
        sessionFilter: this.supportsSessionFilter(),
      });
      // 作用域归属放在 `appliedKey` 短路之前：换会话（session 订阅换 id）与换范围
      // （chat → runs / team / none）都必须**即时覆写**，不能靠「不设」。
      //
      // 为什么非要显式置空：从会话 A 切到 Runs 页后，若保留 A 的残留作用域，Runs 期间
      // 到达的、事件本身不带 `session_id` 的条目会被误归属到 A，回到会话时表现为串台。
      // 见 `EventStore#scopeSession` 与 L-041（事件缓冲不是历史，不能靠“谁最后写的”决定归属）。
      this.eventStore.setScopeSession(serverScopedSessionId(built));
      // **作用域真的变了才清空**（换会话 / 换 Team / chat↔runs）：旧条目属于别的范围，
      // 留着会串台。同一作用域内的重新订阅（重连、gap 重对齐、换过滤参数）**不清空**：
      // 内容原地保留，由 `truncateAfter` + `push` 去重把窗口补回来，屏幕上不会出现空白帧。
      const scopeKey = scopeIdentity(scope);
      if (this.appliedScopeKey !== null && this.appliedScopeKey !== scopeKey) {
        this.eventStore.clear();
      }
      this.appliedScopeKey = scopeKey;
      const key = JSON.stringify(built.filter);
      if (key === this.appliedKey) return;
      this.appliedKey = key;
      this.lastBuilt = built;
      this.clientFilter = built.clientSessionFilter;
      this.pendingHello = 'subscribe';
      let subscribed = false;
      try {
        await this.client.request('events.subscribe', built.filter);
        subscribed = true;
        // 新 gateway 的订阅级 hello 在 res 之前到达，`consumeHello` 已消费；
        // 旧 gateway 不发订阅级 hello，这里清掉在途标记，避免它吞掉下一次
        // 连接级 hello（会导致重连后漏 bump epoch / 漏刷新详情）。
        // 只清自己这一笔：回填页的在途标记不能在这里被抹掉。
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
      } catch {
        // 旧 gateway / 断线：params 被忽略或请求失败。保留路由意图，
        // 重连后的连接级 hello 会重新 apply；期间订阅退回默认过滤。
        this.appliedKey = null;
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
        // hello 到了但 res 失败：回填还没开始跑，撤掉暂存，别让 `push()` 永远只写暂存区。
        if (this.backfillUpper !== null) {
          this.backfillUpper = null;
          this.eventStore.endBackfill();
        }
      }
      // 订阅 hello 判定要回填（`startBackfill` 已退游标 + 暂存）：在这里逐页往回拉。
      // 页订阅与实时订阅共用同一个发送方（本方法），所以实时过滤不会被改成别的会话。
      //
      // 判据只看 `backfillUpper`，不看 `subscribed`：`startBackfill` 是在 hello
      // 处理里被 arm 的（暂存已经生效、游标已经退到 `since`），只要它 arm 了就必须
      // 有人 drain。漏掉这一条的唯一后果是 `holdFloor` 永久生效 —— `push()` 从此只写
      // 暂存区、时间线停在「刚 clear 完」的空状态，用户看到的是「刷新后这次 run 一条
      // 都不显示，之后也不再更新」，只能再刷一次页面才恢复。
      if (this.backfillUpper !== null) {
        if (subscribed) await this.runBackfill(scope, built);
        else {
          // 请求没成功（旧 gateway / 断线）：撤掉暂存，别让 `push()` 永远只写暂存区。
          this.backfillUpper = null;
          this.eventStore.endBackfill();
        }
      }
      // 磁盘段（`D \ R`）：环回填已经收尾、暂存/frozen 都已解除，这里才允许并入更早的
      // 那一段。`subscribed` 是前置条件（旧 gateway 上连方法表都可能没有；没有就
      // fail-open，见 `runReplayBackfill` 里的观测面）。
      if (subscribed && this.diskPending) await this.runReplayBackfill(scope, built);
      // 等待期间路由又变了：用新 scope 再跑一轮。
      if (this.desired === scope) return;
    }
  }
}
