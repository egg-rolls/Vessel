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
 */

import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';
import type { HelloInfo } from './types';

/** 旧 gateway 不识别 `session_id`；用 feature 做版本协商，不用形状探测。 */
export const SESSION_FILTER_FEATURE = 'events.session-filter';

/** 旧 gateway 不识别 `until_seq`（分段回放）；同样走 feature 协商。 */
export const REPLAY_RANGE_FEATURE = 'events.replay-range';

/**
 * 回填页数上限：单页最多 2000 条（服务端回放预算），环形缓冲最多 10000 条，
 * 所以 6 页足以走到缓冲最旧端。走不到就是真的取不到（更早的已被淘汰），停手。
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
   * 连接级 hello 时的服务端最新 seq。重连后自动重新收敛时用它作为
   * `since=currentSeq` 的锚点：连接级回放已经发生，Team / 无范围订阅不必再回放一遍。
   */
  private seqOverride: number | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly eventStore: EventStore,
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
    if (!this.supportsReplayRange()) return;
    // 当前 run 的起点已经在缓冲里（含从连接级回放拿到的那一段）：不需要回填。
    // 这条判据同时覆盖「同一作用域重订阅 / 重连」的重复回填。
    if (this.eventStore.hasNewestRunStart(sessionId)) return;
    const since = built.filter.since;
    const fromSeq = info.from_seq;
    // 已经追平（没有缺口）：常态路径，按 hello 截断即可。
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
      if (subscribed && this.backfillUpper !== null) {
        await this.runBackfill(scope, built);
      }
      // 等待期间路由又变了：用新 scope 再跑一轮。
      if (this.desired === scope) return;
    }
  }
}
