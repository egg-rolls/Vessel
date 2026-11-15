/**
 * 路由级事件订阅控制器（CONTRACT-msg-system §4.1，S2 数据层）。
 *
 * 每个 node 只有一条 WS。路由切换时由本控制器发 `events.subscribe` 收敛过滤，
 * 不再靠「全量回放 + 浏览器开窗」。它不 import 任何 Chat / Team 组件；S3 在路由
 * 变化时调用 `apply(scope)`。
 *
 * ## 0.54：单游标 + **一个**区间回填（ADR-105 §6）
 *
 * chat 订阅的顺序被写死成三步，**不许**并行、不许边回填边追平：
 * 1. 读 `sessions.get.event_cursor` 的 timeline 四字段
 *    （`{timeline_head, wal_head, holes, tainted}`，缺省 = 没有 timeline ⇒ fail-open 到
 *    「只有实时流」的今天）；
 * 2. 用 `planBackfill(cursor, client_timeline_seq)` 算出**一段**区间 `[after+1, wal_head]`
 *    并一次拿全（分页只发生在区间内部，见 `collectTimelineRange`）；拉回来的那一段走
 *    `EventStore#applyTimelineRange` —— 四条校验（连续性 / `count` / 边界 / 重复）任一
 *    不成立就**不合并**、报 `timeline_gap_reported`（UI 污点条可见）、重拉该区间一次；
 * 3. 回填**追平之后**才发 `events.subscribe`（`since = 游标`）：实时流只负责增量，绝不
 *    与回填重叠，于是「先到的尾巴」和「后到的更早一段」这种交错形态从结构上不存在。
 *
 * 今天的旧形态（两阶段 `until_seq` 逐页往更早拉 + `sessions.events`/`events.list`
 * 三源合并 + 押后 + 负数带 + 内容 id 去重）在本单**整段删除**：那是三源（会话日志 /
 * run trace / 进程内环）的补丁，不是时间线的能力。
 *
 * 还没落地的协议（proto-b1 的 `timeline.hello` / `after_timeline_seq`）：区间声明与校验
 * 已经收敛在 `gateway/timeline-protocol.ts` 一处，帧自带四字段后只换头部来源，
 * 调用点不动；**在此之前不伪造帧形状**（今天实时帧只带 hub seq，见
 * `EventStore#LEGACY_HUB_SEQ_BASE` 的兼容说明）。
 */

import { t } from '../i18n';
import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';
import {
  collectTimelineRange,
  planBackfill,
  planRange,
  readTimelineCursor,
  readTimelinePage,
  type TimelineRangeHeader,
} from './timeline-protocol';
import type { HelloInfo } from './types';

/** 旧 gateway 不识别 `session_id`；用 feature 做版本协商，不用形状探测。 */
export const SESSION_FILTER_FEATURE = 'events.session-filter';

/**
 * 区间回填的单次 RPC 超时：回填是**前置**步骤（回填跑完才开实时订阅），所以不能像
 * 旧的两阶段回填那样一路 fail-open 到底 —— 但也不能把首屏吊死：超时 ⇒ 按缺失处理，
 * 四条校验会把它变成一条**可见**的缺口（污点条），实时流随后照常接上。
 */
export const TIMELINE_REQUEST_TIMEOUT_MS = 8_000;

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
 * - Chat 且 gateway 支持 `events.session-filter` → `{session_id, since: 游标}`：回填已经把
 *   `[1..wal_head]` 接上，实时流只要增量（**不再** `since: 0` 重放整段尾部 —— 那正是
 *   「回填与追平重叠」的成因）。
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
        return { filter: { since: opts.currentSeq, session_id: scope.sessionId } };
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

/**
 * 本次订阅能否为事件「盖会话章」（`EventStore#scopeSession` 的取值）。
 *
 * 只在**服务端按 `session_id` 过滤**的 chat 订阅下返回会话 id：
 * - 服务端过滤时事件流里只剩该会话的增量，而 `llm.stream.chunk` / `tool.call.*`
 *   本身不带 `session_id` —— 没有作用域归属，分组就永远拿不到 sessionId，被会话窗口
 *   整段过滤。
 * - 旧 gateway 降级（`clientSessionFilter` 有值）时事件是**未过滤**的，盖章会把别的
 *   会话的事件误归属，因此返回 undefined，由 UI 按事件自报的 session 过滤。
 * - `run` / `runs` / `team` / `none` 范围一律 undefined：它们不是会话订阅，
 *   而且必须是**显式清除**而不是「不设」，否则切走页面后残留作用域会造成串台。
 */
export function serverScopedSessionId(built: BuiltSubscription): string | undefined {
  if (built.clientSessionFilter !== undefined) return undefined;
  return built.filter.session_id;
}

export class SubscriptionController {
  /** 最近一次路由请求的订阅；重连后据此重新收敛。 */
  private desired: SubscriptionScope | null = null;
  /** 当前生效的作用域 key，用于跳过幂等重复订阅。 */
  private appliedKey: string | null = null;
  /** 上一次真正生效的订阅作用域（变化时才清空事件缓冲）。 */
  private appliedScopeKey: string | null = null;
  /** 在途 subscribe：下一个 hello 属于订阅 epoch 还是连接级。 */
  private pendingHello: 'subscribe' | null = null;
  /** 串行化订阅请求；期间的新 scope 合并到下一轮。 */
  private running: Promise<void> | null = null;
  private clientFilter: string | undefined;
  /** 区间回填在跑（防重入：同一轮里 apply / 路由抖动都不该叠第二次）。 */
  private backfilling = false;
  /**
   * 连接级 hello 时的服务端最新 seq。重连后自动重新收敛时用它作为
   * `since=currentSeq` 的锚点：连接级回放已经发生，Team / 无范围订阅不必再回放一遍。
   */
  private seqOverride: number | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly eventStore: EventStore,
    /**
     * 可读提示的出口（缺口必须说出来，不许静默）。
     * 缺省 = 不说话（仍进 `EventStore#timelineGap` 与 console）。
     */
    private readonly notice?: (message: string) => void,
  ) {}

  /** 路由变化时调用；重复 scope 幂等（同一作用域不重复发请求）。 */
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
   * `onHello` 用：这个 hello 属于连接级还是订阅 epoch？
   * 只会让**下一个** hello 命中；连接级 hello 不受影响。
   *
   * 0.54：回填不再由 hello 触发（它按 `event_cursor` 的区间走，且发生在订阅**之前**），
   * 所以这里只有两种答案。实时流的 seq 纪元对齐由调用方做（`truncateLive`）。
   */
  consumeHello(info: HelloInfo): 'connection' | 'subscribe' {
    // `from_seq` 是本次流实际会发送的第一条（旧 hub 空间的坐标）：订阅级 hello 必须让它
    // 生效，否则上一轮更高的水位会把这一轮的帧全判成重复。
    if (info.from_seq > 0) this.eventStore.truncateLive(info.from_seq);
    if (this.pendingHello === null) return 'connection';
    this.pendingHello = null;
    return 'subscribe';
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
    // 故意保留：断线重连回到同一路由时不应清空缓冲（会整页闪）。
  }

  /** feature gate 降级时 UI 应过滤的 session id；服务端已过滤时为 undefined。 */
  get fallbackSessionId(): string | undefined {
    return this.clientFilter;
  }

  private supportsSessionFilter(): boolean {
    return this.client.protocol?.protocol.features.includes(SESSION_FILTER_FEATURE) ?? false;
  }

  /** 读 timeline 游标的四字段（`sessions.get.event_cursor`；旧 gateway 返回 undefined）。 */
  private async readCursor(sessionId: string): Promise<TimelineRangeHeader | undefined> {
    const body = await this.client.request<{ session?: { event_cursor?: unknown } }>(
      'sessions.get',
      { session_id: sessionId, message_limit: 1 },
      TIMELINE_REQUEST_TIMEOUT_MS,
    );
    const cursor = readTimelineCursor(body?.session?.event_cursor);
    if (cursor === undefined) return undefined;
    return planBackfill(cursor, this.eventStore.currentSeq);
  }

  /** 拉一段区间（页只在区间内部）并交回 store 做四条校验。 */
  private async pullRange(sessionId: string, header: TimelineRangeHeader): Promise<'ok' | 'gap'> {
    const fetched = await collectTimelineRange(header, async (sinceSeq, limit) => {
      const body = await this.client.request<unknown>(
        'sessions.events',
        { session_id: sessionId, since_seq: sinceSeq, limit },
        TIMELINE_REQUEST_TIMEOUT_MS,
      );
      return readTimelinePage(body);
    });
    const outcome = this.eventStore.applyTimelineRange(header, fetched.events);
    return outcome.violation === undefined ? 'ok' : 'gap';
  }

  /**
   * 单区间回填：`[client_timeline_seq + 1 .. wal_head]` 一次拿全。
   *
   * 失败处置（写死，与 ADR-105 §7「失败时的处置」同口径）：校验不过 ⇒ **重拉该区间一次**；
   * 还不过 ⇒ 缺口已经进了 `timelineGap`（UI 污点条 + console），实时流照常接上 ——
   * 半段覆盖**绝不**静默：那张条会一直挂着，直到下一次回填把它收掉。
   */
  private async runTimelineBackfill(sessionId: string, scopeKey: string): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      let header: TimelineRangeHeader | undefined;
      try {
        header = await this.readCursor(sessionId);
      } catch {
        // 旧 gateway / 会话不存在：没有 timeline ⇒ fail-open 到「只有实时流」的今天。
        return;
      }
      if (header === undefined) return;
      if (this.scopeChanged(scopeKey)) return;
      if (header.reset === true) {
        // 游标作废（服务端重启 / 会话被冻结后重开）：从 1 重拉整段，item 一起作废。
        this.eventStore.truncateAfter(0);
        const reset = planRange(1, header.end_seq, {
          timeline_head: header.timeline_head,
          wal_head: header.wal_head,
          holes: header.holes,
          tainted: header.tainted,
        });
        header = reset;
      }
      if (header.count === 0 && header.start_seq > header.end_seq) return;
      const first = await this.pullRange(sessionId, header);
      if (first === 'ok') {
        this.eventStore.clearTimelineGap();
        return;
      }
      // 重拉一次（区间是幂等的：`applyTimelineRange` 只在游标之上并入）。
      if (this.scopeChanged(scopeKey)) return;
      const second = await this.pullRange(sessionId, header);
      if (second === 'ok') this.eventStore.clearTimelineGap();
      else this.notice?.(t('timeline.gap.notice'));
    } finally {
      this.backfilling = false;
    }
  }

  /**
   * 服务端 `gap` 帧：**声明式**处理 —— 记成缺口（UI 可见）、重拉那一段区间，
   * **不**再静默退游标（旧行为 `truncateAfter(to_seq)` 会把已经收到的更新内容截掉）。
   *
   * gap 帧本身在 proto-b1 里被删（ADR-105 §6「`gap` 帧删除」），在那之前只能如实转记。
   */
  async fillTimelineGap(sessionId: string, fromSeq: number, toSeq: number): Promise<void> {
    if (!(toSeq >= fromSeq) || fromSeq < 1) return;
    let header: TimelineRangeHeader | undefined;
    try {
      const body = await this.client.request<{ session?: { event_cursor?: unknown } }>(
        'sessions.get',
        { session_id: sessionId, message_limit: 1 },
        TIMELINE_REQUEST_TIMEOUT_MS,
      );
      const cursor = readTimelineCursor(body?.session?.event_cursor);
      if (cursor === undefined) return;
      header = planRange(fromSeq, toSeq, cursor);
    } catch {
      return;
    }
    const outcome = await this.pullRange(sessionId, header);
    if (outcome === 'ok') this.eventStore.clearTimelineGap();
  }

  private scopeChanged(scopeKey: string): boolean {
    return this.desired === null || scopeIdentity(this.desired) !== scopeKey;
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
      const scopeKey = scopeIdentity(scope);
      // 作用域归属放在幂等短路之前：换会话（session 订阅换 id）与换范围
      // （chat → runs / team / none）都必须**即时覆写**，不能靠「不设」。
      //
      // 为什么非要显式置空：从会话 A 切到 Runs 页后，若保留 A 的残留作用域，Runs 期间
      // 到达的、事件本身不带 `session_id` 的条目会被误归属到 A，回到会话时表现为串台。
      // 见 `EventStore#scopeSession` 与 L-041（事件缓冲不是历史，不能靠“谁最后写的”决定归属）。
      // 会话归属只有一个来源：**服务端真按会话过滤**时的当前范围本身；旧 gateway
      // 降级（客户端过滤）必须给 undefined，否则会把隔壁会话的事件也盖上这个章。
      const sessionScoped =
        scope.kind === 'chat' && this.supportsSessionFilter() ? scope.sessionId : undefined;
      this.eventStore.setScopeSession(sessionScoped);
      // **作用域真的变了才清空**（换会话 / 换 Team / chat↔runs）：旧条目属于别的范围，
      // 留着会串台。同一作用域内的重新订阅（重连、gap 重对齐、换过滤参数）**不清空**：
      // 内容原地保留，由 `truncateAfter` + `push` 去重把窗口补回来，屏幕上不会出现空白帧。
      if (this.appliedScopeKey !== null && this.appliedScopeKey !== scopeKey) {
        this.eventStore.clear();
      }
      this.appliedScopeKey = scopeKey;
      if (this.appliedKey === scopeKey) return;
      // ① 回填（只在 chat 且服务端按会话过滤时）：**在实时订阅之前**一次拿全一个区间。
      if (sessionScoped !== undefined) {
        await this.runTimelineBackfill(sessionScoped, scopeKey);
        if (this.desired !== scope) continue;
      }
      // ② 回填追平之后才开实时订阅：`since` 取**当前游标**，所以实时流只送增量，
      //    与回填的区间不重叠（「边回填边追平」的形态从结构上不存在）。
      const built = buildSubscription(scope, {
        // chat：回填已经追平，实时流只要增量（游标就是右端）；team / none 沿用连接级
        // hello 给的锚点（它们本来就不重放历史）；runs / run 固定 `since: 0`。
        currentSeq: scope.kind === 'chat' ? this.eventStore.currentSeq : baseSeq,
        sessionFilter: this.supportsSessionFilter(),
      });
      this.appliedKey = scopeKey;
      this.clientFilter = built.clientSessionFilter;
      this.pendingHello = 'subscribe';
      try {
        await this.client.request('events.subscribe', built.filter);
        // 新 gateway 的订阅级 hello 在 res 之前到达，`consumeHello` 已消费；
        // 旧 gateway 不发订阅级 hello，这里清掉在途标记，避免它吞掉下一次
        // 连接级 hello（会导致重连后漏 bump epoch / 漏刷新详情）。
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
      } catch {
        // 旧 gateway / 断线：params 被忽略或请求失败。保留路由意图，
        // 重连后的连接级 hello 会重新 apply；期间订阅退回默认过滤。
        this.appliedKey = null;
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
      }
      // 等待期间路由又变了：用新 scope 再跑一轮。
      if (this.desired === scope) return;
    }
  }
}
