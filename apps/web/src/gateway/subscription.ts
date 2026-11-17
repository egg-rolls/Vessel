/**
 * 路由级事件订阅控制器（CONTRACT-msg-system §4.1，S2 数据层）。
 *
 * 每个 node 只有一条 WS。路由切换时由本控制器发 `events.subscribe` 收敛过滤，
 * 不再靠「全量回放 +
             + 浏览器开窗」。它不 import 任何 Chat / Team 组件；S3 在路由
 * 变化时调用 `apply(scope)`。
 *
 * ## 0.54：单游标 +
             + **一个**区间回填（ADR-105 §6）
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
 * 今天的旧形态（两阶段 `until_seq` 逐页往更早拉 +
             + `sessions.events`/`events.list`
 * 三源合并 +
             + 押后 +
             + 负数带 +
             + 内容 id 去重）在本单**整段删除**：那是三源（会话日志 /
 * run trace / 进程内环）的补丁，不是时间线的能力。
 *
 * 协议来源（proto-b1 已合入）：`timeline.hello` 的四字段与 `after_timeline_seq` 就是这里
 * 的唯一输入 —— 区间声明 / 校验 / 续拉全部收敛在 `gateway/timeline-protocol.ts` 一处，
 * 客户端只持一个 `client_timeline_seq`，没有第二套 seq 空间。
 */

import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';
import {
  collectTimelineRange,
  contiguousPrefixEnd,
  cursorTarget,
  isInvalidParamsError,
  LEGACY_TIMELINE_PAGE_LIMIT,
  MAX_TIMELINE_SEGMENTS,
  planBackfill,
  planEarlierRange,
  planRange,
  readTimelineCursor,
  readTimelineHelloSegment,
  readTimelinePage,
  TIMELINE_EVENTS_PAGE_LIMIT,
  type TimelineCursor,
  type TimelinePage,
  type TimelineRangeHeader,
  tailWindowStart,
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
  /**
   * 0.60：进程级全局流的显式 opt-in（服务端 allow_global）。
   *
   * 只有「确实要全部事件族」的范围才配它（见 buildSubscription 的 none 分支）；会话 /
   * run / types 订阅一律不要带 —— 带了就等于放弃服务端那道默认拒绝。
   */
  allow_global?: boolean;
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
      // 0.60：服务端的默认已经变成「没有会话作用域就一条都不发」，所以这条范围必须**显式
      // opt-in** 才拿得到原来的流。为什么仍然要全局流：「无明确范围」覆盖了 agents / pending
      // 等页面，它们各自读的是不同的事件族（agent.* / team.* / session.* / tool.permission.*），
      // 用一个 types 前缀表去猜只会漏 —— 漏掉的那一族在屏上表现为「状态不动」。
      //
      // 这条 opt-in 是**显式**的（写在代码里、可 review）：一旦有人把某个页面的订阅改成
      // 不带 session_id 又没写这句，服务端会直接拒掉而不是静默全发。
      return { filter: { since: opts.currentSeq, allow_global: true } };
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

/**
 * 一次续拉回填的观测面（真机排查 / 探针读它；`console.info` 打的是同一组数）。
 *
 * `segments` = 续拉了几段；`declared` = 各段声明条数之和；`received` = 实际并入 +
             + 判重复
 * 的条数之和（两者相等才说明"声明多少收了多少"）；`end` / `target` = 停下来的游标与应到的
 * 右端（`min(wal_head, published_head)`）。
 */
export interface BackfillReport {
  segments: number;
  /** 各段**声明**条数之和（= 各段区间长度减去声明洞）。 */
  declared: number;
  /** 各段**从线上实收**的行数之和。`declared === fetched` 才说明「声明多少收多少」。 */
  fetched: number;
  /** 真正进环 / 记重复的条数（其余是传输噪声：chunk delta 等不产 item 的增量）。 */
  received: number;
  /** 停下来的游标（应等于 `target`）。 */
  end: number;
  /** 应到的右端 = `min(wal_head, published_head)`。 */
  target: number;
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
  /** 最近一次续拉回填的数字（见 `BackfillReport`）。 */
  lastBackfill: BackfillReport | null = null;
  /** 本作用域已确认「不能按 `after_timeline_seq` 订阅」（旧格式会话冻结）⇒ 走老参数。 */
  private readonly legacyScopes = new Set<string>();
  /** 区间回填在跑（防重入：同一轮里 apply / 路由抖动都不该叠第二次）。 */
  private backfilling = false;
  /** 更早一段（滚动加载）在途：滚动事件很密，同一时刻只允许一段。 */
  private loadingEarlier = false;
  /**
   * 连接级 hello 时的服务端最新 seq。重连后自动重新收敛时用它作为
   * `since=currentSeq` 的锚点：连接级回放已经发生，Team / 无范围订阅不必再回放一遍。
   */
  private seqOverride: number | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly eventStore: EventStore,
  ) {
    // 续拉循环的实时流那一半：本趟 epoch 收尾（`timeline-epoch-end` 帧）后，若服务端说
    // 后面还有可读的 / 或本趟末 seq 还没到应到右端（每趟 ≤ 2000 条导致的），立刻按
    // `after_timeline_seq = 游标` 再订一次。
    //
    // 0.55：结趟的唯一判据是这条帧（不再有 400ms 空闲猜测）。它可能在本轮 `run()` 还在
    // 等 `res` 时到达 —— 那时 `apply()` 会被 `running !== null` 短路丢掉，所以这里只置一个
    // 续订意图，由 `run()` 的循环自己接（见 `continuationPending`）。
    this.eventStore.setEpochEndHook((header, settle) => {
      if (!this.advanceEpoch(header, settle)) return;
      const scope = this.desired;
      if (scope === null) return;
      this.continuationPending = true;
      // 清掉幂等短路：同一作用域也要再发一次 `events.subscribe`（新的排他游标）。
      this.appliedKey = null;
      void this.apply(scope);
    });
  }

  /** 本趟 epoch 应到的右端（`min(wal_head, published_head)`；无 timeline 时为 0）。 */
  private epochTarget = 0;
  /** 本趟订阅发出时的游标（判断"这一趟有没有前进"）。 */
  private epochSubscribeFrom = 0;
  /** 连续几趟 epoch 没有前进（`>= 2` 就不再续订）。 */
  private epochStalls = 0;
  /**
   * 「本趟收尾要求再订一次」的意图。`run()` 之外来的收尾（结束帧 / 定时外的回调）直接
   * `apply()` 就够；`run()` 内部来的那条（订阅 `res` 已回）会撞上 `running !== null` 的
   * 幂等短路，所以两个入口都统一置这个标志，由 `run()` 的循环决定是否再跑一轮。
   */
  private continuationPending = false;
  /**
   * **尾部窗口左端 - 1**（订阅 `since` / `after_timeline_seq` 的下限）。
   *
   * 为什么需要它（tail-window 的 (b)）：回填失败（读面超时 / 旧 gateway）时单游标停在
   * 0，`after_timeline_seq = 0` 会让服务端**从 seq 1 回放**——19 万 seq 的会话首屏就会
   * 把最老的那一批事件塞进包里（帧数有界，但内容是最老的一段，不是尾部窗口）。
   * 这里把订阅起点夹到**当前尾部窗口**的左端，与首屏回填同一个预算口径
   * （`TIMELINE_TAIL_WINDOW_EVENTS`）；代价是回填失败时首屏只有窗口内容 —— 那比
   * 「显示会话开头」诚实，且滚动到顶仍可往前要（`hasEarlier` 由回填/滚动加载落位）。
   *
   * 只在 chat 作用域用；由 `runTimelineBackfill` 每次读游标时重算（0 = 不知道，不夹）。
   */
  private tailWindowFloor = 0;
  /**
   * 本轮读不到时间线游标（`sessions.get.event_cursor` 超时 / 失败）。
   *
   * **绝不能**带着「游标 0」去订阅：`after_timeline_seq = 0` 是**合法请求**，服务端会从
   * seq 1 开始堂堂正正地发，客户端的续拉循环于是从会话开头一路追到末尾 —— 2026-11-17
   * 事故（30,061 帧 / 12.5 MB / node 探活失败被看门狗重启）。
   *
   * 本轮退到**有界 hub 尾窗**（老订阅参数），下一次 `apply` 再试时间线。
   */
  private timelineCursorUnavailable = false;
  /** 服务端声明了 `reset`（本地游标越过了 `wal_head`）：本轮结束前重新锚到尾部窗口。 */
  private resetReanchor = false;

  /**
   * 本趟收尾之后是否还要再订一次（服务端每趟 ≤ 2000 条，续拉到应到右端为止）。
   *
   * 三条出口，判据全部来自**显式事实**：
   * - 服务端显式说 `has_more: false`（`timeline-epoch-end`）⇒ 到头了，停。**不能**用
   *   `end_seq < 应到右端` 代替：尾部只剩写者声明的洞时那个比较恒真，续拉会原地打转
   *   （每趟 0 条、`has_more` 仍为真）；
   * - 本趟末 seq 已到应到右端 ⇒ 停；
   * - 连续两趟没有任何进展 ⇒ 停（再订只会得到同一条空区间；缺口已由 store 报）。
   */
  private advanceEpoch(header: { end_seq: number }, settle: { hasMore?: boolean }): boolean {
    if (settle.hasMore === false) {
      this.epochStalls = 0;
      return false;
    }
    if (header.end_seq >= this.epochTarget) {
      this.epochStalls = 0;
      return false;
    }
    this.epochStalls =
      this.eventStore.currentSeq > this.epochSubscribeFrom ? 0 : this.epochStalls + 1;
    return this.epochStalls < 2;
  }

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
   * 所以这里只有两种答案。帧 seq 与游标同一空间，不需要任何"纪元对齐"。
   */
  consumeHello(info: HelloInfo): 'connection' | 'subscribe' {
    // 0.55：判据是**形状**（`hello.timeline` 在不在）。在 ⇒ 本 epoch 的帧带
    // `timeline_seq`，四条校验在实时流上做（服务端**声明**了区间与 `count`）；
    // 不在 ⇒ 老 epoch，帧带 hub seq，按老行为处理。
    const header = readTimelineHelloSegment(info.timeline);
    // `connectionLevel` 是客户端内部标记（`connect()` 等的那条 hello）。`pendingHello`
    // 只能回答「有没有订阅在途」，在重连 / 订阅超时交错时会把连接级 hello 认成订阅级。
    const connectionLevel = info.connectionLevel === true || this.pendingHello === null;
    // 连接级回放的帧是**进程级 hub seq**，与时间线会话 seq 不可比。timeline-capable
    // 服务的 chat 内容全部由「回填 + 时间线订阅」负责，所以这段回放对 chat 无价值：
    // 只隔离，**不碰游标**（历史上这里把 hub 游标写进时间线游标，下一次订阅越过
    // `wal_head`，服务端按 reset 从 seq 1 重放整段历史）。
    if (
      connectionLevel &&
      header === undefined &&
      this.supportsTimeline() &&
      this.desired?.kind === 'chat'
    ) {
      // 上一连接留下的 epoch 已不可续（新连接的第一趟订阅会重新声明）。
      this.epochTarget = 0;
      this.eventStore.endTimelineEpoch();
      this.eventStore.setSuppressLegacyFrames(true);
      return 'connection';
    }
    if (header !== undefined) {
      // 本趟应到的右端：`(published_head, wal_head]` 允许不被推送，所以取 min。
      const published = info.timeline?.published_head;
      this.epochTarget =
        typeof published === 'number'
          ? Math.min(header.wal_head, Math.min(published, header.wal_head))
          : header.wal_head;
      if (header.reset === true) {
        // 本地游标越过了 `wal_head`（跨序号空间 / 时间线重开）：服务端的 reset 段是
        // 「从 seq 1 重放」，不是用户要的内容。丢弃缓冲、锚到尾部窗口，下一轮重新回填。
        this.eventStore.endTimelineEpoch();
        this.eventStore.truncateAfter(0);
        this.eventStore.setSuppressLegacyFrames(false);
        this.tailWindowFloor = tailWindowStart(this.epochTarget) - 1;
        this.eventStore.setSeqFloor(this.tailWindowFloor);
        this.resetReanchor = true;
        if (this.pendingHello === null) return 'connection';
        this.pendingHello = null;
        return 'subscribe';
      }
      this.eventStore.beginTimelineEpoch(header);
    } else {
      this.epochTarget = 0;
      this.eventStore.endTimelineEpoch();
      // 订阅级老 epoch（旧 gateway / 回填失败降级 / 非 chat 范围）：帧 seq 是同一个
      // 计数空间的起点 `from_seq`，游标退到它之前 —— 随后到达的重放帧才会被收下
      // （`truncateAfter` 只动传输窗口，不动 item，I6）。
      this.eventStore.setSuppressLegacyFrames(false);
      if (info.from_seq > 0) this.eventStore.truncateAfter(Math.max(0, info.from_seq - 1));
    }
    if (this.pendingHello === null) return 'connection';
    this.pendingHello = null;
    return 'subscribe';
  }

  /** 服务端是否真的装配了时间线读面（能力位是唯一判据，不做形状探测）。 */
  private supportsTimeline(): boolean {
    return this.client.protocol?.protocol.features.includes('timeline.cursor') ?? false;
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
    // 0.60：断线后服务端是**无过滤**连接（新连接在 `events.subscribe` 之前没有任何会话
    // 作用域），所以作用域必须一起清掉：重连窗口期到达的帧不属于任何会话，不能被
    // 盖上旧会话的章。订阅成功后由 `run()` 重新设置。
    this.eventStore.setScopeSession(undefined);
    // 故意保留：断线重连回到同一路由时不应清空缓冲（会整页闪）。
  }

  /** feature gate 降级时 UI 应过滤的 session id；服务端已过滤时为 undefined。 */
  get fallbackSessionId(): string | undefined {
    return this.clientFilter;
  }

  private supportsSessionFilter(): boolean {
    return this.client.protocol?.protocol.features.includes(SESSION_FILTER_FEATURE) ?? false;
  }

  /**
   * 一次 `sessions.events` 要多少条（0.57）。一页 2000 = 一段 2000 条，首屏从 4 次
   * 串行往返降到 1 次；旧 gateway（硬顶 500）会 `invalid_params`，那时**永久**退回 500。
   *
   * 为什么是「记住」而不是每次先试大页：退过一次就说明对端是旧版本，之后每条回填再白撞
   * 一次失败 + 重试没有意义（首屏每滚一段都要付一次）。
   */
  private eventsPageLimit: number = TIMELINE_EVENTS_PAGE_LIMIT;

  /** 读 timeline 游标（`sessions.get.event_cursor` 四字段；旧 gateway 返回 undefined）。 */
  private async readCursor(sessionId: string): Promise<TimelineCursor | undefined> {
    const body = await this.client.request<{ session?: { event_cursor?: unknown } }>(
      'sessions.get',
      { session_id: sessionId, message_limit: 1 },
      TIMELINE_REQUEST_TIMEOUT_MS,
    );
    return readTimelineCursor(body?.session?.event_cursor);
  }

  /**
   * 取一页 `sessions.events`。
   *
   * 大页被旧的 gateway 拒了（`invalid_params`：0.57 之前 `MAX_SESSION_EVENTS_LIMIT` 是
   * 500）就**退回 500 再把这一页要一遍**，并把 {@link eventsPageLimit} 永久降级 ——
   * 首屏数据不许因为「页要得太大」少一条，也不许因此报缺口。
   */
  private async fetchTimelinePage(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<TimelinePage> {
    try {
      const body = await this.client.request<unknown>(
        'sessions.events',
        { session_id: sessionId, since_seq: sinceSeq, limit },
        TIMELINE_REQUEST_TIMEOUT_MS,
      );
      return readTimelinePage(body);
    } catch (error) {
      if (limit <= LEGACY_TIMELINE_PAGE_LIMIT || !isInvalidParamsError(error)) throw error;
      this.eventsPageLimit = LEGACY_TIMELINE_PAGE_LIMIT;
      const body = await this.client.request<unknown>(
        'sessions.events',
        { session_id: sessionId, since_seq: sinceSeq, limit: LEGACY_TIMELINE_PAGE_LIMIT },
        TIMELINE_REQUEST_TIMEOUT_MS,
      );
      return readTimelinePage(body);
    }
  }

  /** 拉一段区间（页只在区间内部）并交回 store 做四条校验。 */
  private async pullRange(
    sessionId: string,
    header: TimelineRangeHeader,
  ): Promise<{ ok: boolean; merged: number; duplicates: number; fetched: number; end: number }> {
    const fetched = await collectTimelineRange(
      header,
      (sinceSeq, limit) => this.fetchTimelinePage(sessionId, sinceSeq, limit),
      this.eventsPageLimit,
    );
    const seqs = fetched.events.map((event) => event.seq);
    let effective = header;
    let outcome = this.eventStore.applyTimelineRange(header, fetched.events, sessionId);
    // 「声明了一段、实收只是它的**连续前缀**」不是丢数据，是这一趟没发完（服务端撞背压
    // 会提前停）。这时按实收末 seq 收缩声明再并 —— 判缺口的时机推迟到「确认无法继续」
    // （回填循环里的 no-progress / epoch 的 stall），不在这里按每批到达即判。
    if (outcome.violation?.rule === 3) {
      const prefixEnd = contiguousPrefixEnd(
        header,
        [...seqs].sort((left, right) => left - right),
      );
      if (prefixEnd !== undefined && prefixEnd >= header.start_seq) {
        effective = planRange(header.start_seq, prefixEnd, {
          timeline_head: header.timeline_head,
          wal_head: header.wal_head,
          holes: header.holes,
          tainted: header.tainted,
        });
        outcome = this.eventStore.applyTimelineRange(effective, fetched.events, sessionId);
      }
    }
    return {
      ok: outcome.violation === undefined,
      merged: outcome.merged,
      duplicates: outcome.duplicates,
      fetched: fetched.events.length,
      end: effective.end_seq,
    };
  }

  /**
   * 单游标回填 = **续拉循环**：`after = 游标`，一段 ≤ `TIMELINE_SEGMENT_MAX_EVENTS` 条，
   * 每段独立过四条校验，跑完接着下一段，直到 `游标 == min(wal_head, published_head)`。
   *
   * **首屏必须有界：一次刷新推 19 万帧会把 WS 压死（2026-11-16 事故）。** 所以循环的起点
   * 不是 1，而是**尾部窗口**的左端（`tailWindowStart(target)`）：19 万 seq 的会话刷新一次
   * 只推 2000 条（一段），更早的内容由 `loadEarlier()` 在滚到顶时一段一段补。
   * 任何「刷新就续拉到会话末尾」的形态都是这次事故的复现。
   *
   * 为什么必须分段（而不是"一次声明整段 +
             + 抬高上限"）：服务端每趟订阅最多送 2000 条 /
   * 2 MiB，背压时停且不推游标 —— 一次声明 17 万条的结果是"声明了但发不完"，于是客户端的
   * 四条校验必然报边界缺口（真机上那个假警报就是这个形态）。分段之后**每段自洽**：
   * 声明多少收多少、校验多少、失败也只重拉这一段。
   *
   * 失败处置（ADR-105 §7「失败时的处置」同口径）：某一段校验不过 ⇒ **重拉这一段一次**；
   * 还不过 ⇒ 缺口进 `timelineGap`（数据面记账 + console + `timeline_gap_reported` 上报，
   * **不上界面**）并停手 —— 半段覆盖绝不静默。
   *
   * 观测：跑完打一行
   * `[timeline-backfill] segments=… declared=… fetched=… entries=… end=… target=…`，
   * 探针与真机排查都读这一行（`lastBackfill` 也是同一组数）。`declared === fetched` 是
   * 「每段声明多少就收多少」的直接证据；`entries` 小一些是正常的（chunk delta 不产 item）。
   */
  private async runTimelineBackfill(sessionId: string, scopeKey: string): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    const report: BackfillReport = {
      segments: 0,
      declared: 0,
      fetched: 0,
      received: 0,
      end: 0,
      target: 0,
    };
    try {
      let cursor: TimelineCursor | undefined;
      try {
        cursor = await this.readCursor(sessionId);
      } catch {
        // 读不到游标 = 现在不知道会话头在哪。**绝不能**退成 `after_timeline_seq = 0`：
        // 那是合法请求，服务端会从 seq 1 发，续拉循环一路追到末尾（2026-11-17 事故）。
        // 记下来，本轮退到「有界 hub 尾窗」，下一次 apply 再试时间线。
        this.timelineCursorUnavailable = true;
        return;
      }
      if (cursor === undefined) {
        // 旧 gateway（不带四字段）/ 会话不存在：本轮同样按「没有时间线」降级。
        this.timelineCursorUnavailable = true;
        return;
      }
      this.timelineCursorUnavailable = false;
      if (this.scopeChanged(scopeKey)) return;
      const target = cursorTarget(cursor);
      report.target = target;
      report.end = this.eventStore.currentSeq;
      // 环里有事件但**没有任何已并入的区间**（左缘 0）⇒ 它们来自连接级 hub 回放
      // （两套编号不可比）。在时间线落位前清掉，避免幽灵 item 与一个假的游标起点。
      // 只在会话确实有时间线内容（`target > 0`）时做：空会话没有可落位的东西。
      if (target > 0 && this.eventStore.earliestLoadedSeq === 0 && this.eventStore.currentSeq > 0) {
        this.eventStore.truncateAfter(0);
        report.end = this.eventStore.currentSeq;
      }
      // **订阅起点也要服从同一个预算**（tail-window 的 (b)）：回填失败时单游标停在 0，
      // 订阅 `after_timeline_seq = 0` 会让服务端从 seq 1 回放最老的一批帧。夹到尾部窗口
      // 左端 ⇒ 首屏最多只有窗口内容，不会把会话开头当成首屏（见 `tailWindowFloor`）。
      this.tailWindowFloor = target > 0 ? tailWindowStart(target) - 1 : 0;
      if (this.eventStore.currentSeq > cursor.wal_head) {
        // 游标作废（服务端重启 / 会话被冻结后重开）：从 1 重拉，item 一起作废。
        this.eventStore.truncateAfter(0);
      }
      // **首屏必须有界**：刷新只回填尾部窗口 `[tailWindowStart(target) .. target]`。
      // 一次刷新推 19 万帧会把 WS 压死（2026-11-16 事故）—— 那次就是从这里一路续拉到
      // 会话末尾。游标落后于窗口左端时**直接锚到左端**（不从 1 追），更早的段由
      // `loadEarlier()` 在滚到顶时一段一段补（`EventStore#hasEarlier`）。
      const floor = tailWindowStart(target) - 1;
      for (let index = 0; index < MAX_TIMELINE_SEGMENTS; index += 1) {
        let after = this.eventStore.currentSeq;
        // 游标可能来自刷新前的持久化值 / 别的 seq 空间：**环里没有任何已加载窗口**时
        // （`earliestLoadedSeq === 0`）无条件锚到尾部窗口，否则首屏只有「游标之后」
        // 那一小段，左边永远差一截。
        if (after < floor || this.eventStore.earliestLoadedSeq === 0) after = floor;
        if (after >= target) break;
        const header = planBackfill(cursor, after);
        if (header === undefined) break;
        report.declared += header.count;
        report.segments += 1;
        let outcome = await this.pullRange(sessionId, header);
        // 「这一趟没发完」= 实收是连续前缀、游标前进了：继续下一段（不算缺口）。
        // 只有**同一游标再要一次仍不前进**才判缺口（ADR-105 §6 的"确认无法继续"）。
        if (outcome.ok === false && !this.scopeChanged(scopeKey)) {
          outcome = await this.pullRange(sessionId, header);
        }
        report.fetched += outcome.fetched;
        report.received += outcome.merged + outcome.duplicates;
        const advanced = this.eventStore.currentSeq > after;
        if (outcome.ok === false) {
          if (!advanced) {
            // 从同一游标再要一次也没前进 ⇒ 确认无法继续，才报缺口（不弹用户，只上报 + console）。
            this.eventStore.reportTimelineGap({
              from_seq: after + 1,
              to_seq: header.end_seq,
              source: 'fetch',
              rule: 3,
              expected: `[${String(header.start_seq)}, ${String(header.end_seq)}] 可读`,
              received: `这一段没有任何前进（停在 ${String(after)}）`,
              expectedCount: header.count,
              receivedCount: outcome.fetched,
              at: Date.now(),
            });
            // 面向用户的提示一律不发（用户定：这类内部时序细节不该出现在前端）；
            // 出口只有 `reportTimelineGap` 里的 console + `timeline_gap_reported` 上报。
            break;
          }
          continue;
        }
        this.eventStore.clearTimelineGap();
        if (this.scopeChanged(scopeKey)) break;
      }
      report.end = this.eventStore.currentSeq;
      // 触顶也是缺口（游标不前进 = 真故障），不许静默；正常的几十段以内一定会先 break。
      if (report.segments >= MAX_TIMELINE_SEGMENTS && report.end < target) {
        this.eventStore.reportTimelineGap({
          from_seq: report.end + 1,
          to_seq: target,
          source: 'fetch',
          rule: 3,
          expected: `追平到 ${String(target)}`,
          received: `停在 ${String(report.end)}（${String(MAX_TIMELINE_SEGMENTS)} 段上限）`,
          expectedCount: target - report.end,
          receivedCount: 0,
          at: Date.now(),
        });
      }
    } finally {
      this.backfilling = false;
      this.lastBackfill = report;
      if (report.segments > 0) {
        console.info(
          `[timeline-backfill] session=${sessionId} segments=${String(report.segments)}` +
            ` declared=${String(report.declared)} fetched=${String(report.fetched)}` +
            ` entries=${String(report.received)}` +
            ` end=${String(report.end)} target=${String(report.target)}` +
            // **首屏必须有界**：`target - end` 的差就是「首屏没加载的那一段」，它由
            // `hasEarlier` 表达、由滚动加载补（见 `loadEarlier`）。`items` 是屏上总量，
            // 用来对数「分段加载 == 整份加载」。
            ` items=${String(this.itemCount())}`,
        );
      }
    }
  }

  /**
   * 滚动到顶时向**更早**要一段（分段滚动加载，`EventStore#hasEarlier` 为真时才有事做）。
   *
   * 为什么在订阅层而不在 store 里：这一段要「读 `sessions.get.event_cursor` + 按区间拉
   * `sessions.events` + 四条校验 + 前缀收缩重试」，那就是 `readCursor` / `pullRange` 那一套
   * （与回填**同一套代码**，不另写一份）。store 只表达状态（`hasEarlier` /
   * `earliestLoadedSeq`），发起请求的职责留在这里。
   *
   * **首屏必须有界：一次刷新推 19 万帧会把 WS 压死（2026-11-16 事故）。** 首屏只加载
   * 尾部窗口（`TIMELINE_TAIL_WINDOW_EVENTS`），更早的内容就靠这里：每次一段
   * `[左缘 - 窗口 .. 左缘 - 1]`，成功之后左缘随之前移（下一段从新的左缘往前接），
   * 到 1 就 `hasEarlier === false`，滚动不再发请求。
   *
   * 失败处置与回填同口径：同一段要两次仍不过 ⇒ 记一条缺口（console + 上报），停手；
   * **界面上不出现任何新元素**（用户口径：前端要清爽），滚动加载的可见反馈只有内容本身
   * 在顶部慢慢长出来。
   */
  async loadEarlier(): Promise<void> {
    if (this.loadingEarlier) return;
    const sessionId = this.eventStore.scopeSessionId;
    if (sessionId === undefined || !this.eventStore.hasEarlier) return;
    this.loadingEarlier = true;
    try {
      let cursor: TimelineCursor | undefined;
      try {
        cursor = await this.readCursor(sessionId);
      } catch {
        // 旧 gateway / 会话不存在：没有 timeline 就没有更早的段（与回填同口径）。
        return;
      }
      if (cursor === undefined) return;
      // 期间换了会话 / 换出 chat 范围：这一段属于别的会话，不许并进来。
      if (this.eventStore.scopeSessionId !== sessionId) return;
      const from = this.eventStore.earliestLoadedSeq;
      const header = planEarlierRange(cursor, from);
      if (header === undefined) return;
      let outcome = await this.pullRange(sessionId, header);
      if (outcome.ok === false) outcome = await this.pullRange(sessionId, header);
      if (outcome.ok === false) {
        this.eventStore.reportTimelineGap({
          from_seq: header.start_seq,
          to_seq: header.end_seq,
          source: 'fetch',
          rule: 3,
          expected: `[${String(header.start_seq)}, ${String(header.end_seq)}] 可读`,
          received: `这一段要了两次都没通过（实收 ${String(outcome.fetched)}）`,
          expectedCount: header.count,
          receivedCount: outcome.fetched,
          at: Date.now(),
        });
        return;
      }
      this.eventStore.clearTimelineGap();
      console.info(
        `[timeline-earlier] session=${sessionId} from=${String(from)}` +
          ` start=${String(header.start_seq)} end=${String(header.end_seq)}` +
          ` fetched=${String(outcome.fetched)} merged=${String(outcome.merged)}` +
          ` floor=${String(this.eventStore.earliestLoadedSeq)}` +
          ` hasEarlier=${String(this.eventStore.hasEarlier)}` +
          ` items=${String(this.itemCount())}`,
      );
    } finally {
      this.loadingEarlier = false;
    }
  }

  /** 屏上 item 总数（滚动加载的观测数：内容「长出来」了多少）。 */
  private itemCount(): number {
    let total = 0;
    for (const group of this.eventStore.items.getSnapshot().groups) total += group.items.length;
    return total;
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
    if (outcome.ok) this.eventStore.clearTimelineGap();
  }

  private scopeChanged(scopeKey: string): boolean {
    return this.desired === null || scopeIdentity(this.desired) !== scopeKey;
  }

  /**
   * 发一次 `events.subscribe`：**先按新协议**（`after_timeline_seq`，排他游标，不要 `since`），
   * 被拒（旧格式会话冻结 / 服务端没装 timeline 读面）才退回老参数。
   *
   * 为什么必须两条：服务端对「同时给 `since` 和 `after_timeline_seq`」是 `invalid_params`
   * （两套编号不许混），而**旧格式会话**按 `after_timeline_seq` 订阅会被
   * `session_frozen_readonly` 拒 —— 那种会话只能走老参数（它的帧带 hub seq，四条校验自动
   * 关掉，见 `consumeHello`）。退回一次就记进 `legacyScopes`，同一作用域不再重试新参数。
   *
   * `afterSeq` 是**已经夹过尾部窗口**的起点（见 `tailWindowFloor`）：回填失败时它不等于
   * 单游标 0，而等于尾部窗口左端 —— 否则服务端会从 seq 1 回放最老的那一批。
   */
  private async subscribeOnce(
    scopeKey: string,
    sessionId: string | undefined,
    afterSeq: number,
    legacyFilter: SubscriptionFilter,
    forceLegacy = false,
  ): Promise<void> {
    // 这一趟从哪个游标出发（`advanceEpoch` 判「有没有前进」要它；旧实现从未赋值，
    // 于是 stall 保护恒不触发 —— 0.55 一起修掉）。
    this.epochSubscribeFrom = afterSeq;
    // `forceLegacy` = 调用方已经决定「这一轮不走时间线」（没有会话 / 游标读不到）。
    // 不能靠「sessionId 为 undefined ⇒ 试一下」：`after_timeline_seq` 缺 `session_id`
    // 会被服务端按 `invalid_params` 拒，非 chat 范围与降级路径都会因此拿不到订阅。
    if (!forceLegacy && (sessionId === undefined || !this.legacyScopes.has(scopeKey))) {
      this.pendingHello = 'subscribe';
      try {
        await this.client.request('events.subscribe', {
          session_id: sessionId,
          after_timeline_seq: afterSeq,
        });
        return;
      } catch {
        if (sessionId === undefined) throw new Error('subscribe failed');
        // 只有「这个会话按时间线订阅不了」才退回；其它错误交给上层（旧 gateway / 断线）。
        this.legacyScopes.add(scopeKey);
      }
    }
    this.pendingHello = 'subscribe';
    await this.client.request('events.subscribe', legacyFilter);
  }

  private async run(): Promise<void> {
    // 先让出一次微任务：保证 `apply` 里的 `this.running = promise` 一定发生在
    // 本次 run 可能同步结束之前。
    await Promise.resolve();
    // 上一轮遗留的续订意图由**这次** run 覆盖（它本身就是那次续订），先清掉再跑。
    this.continuationPending = false;
    // 每次 apply 都重新给时间线一次机会（上一轮可能只是 `sessions.get` 超时）。
    this.timelineCursorUnavailable = false;
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
      // 0.60：**确认之后才盖章**。作用域必须在服务端真的按这个会话过滤时才算数，
      // 所以它跟订阅结果走，不跟路由意图走：
      //
      // - 订阅还没落地（WS 刚连上 / 刚换范围）时服务端是**无过滤**连接 —— 这段时间
      //   到达的帧属于所有会话，先盖章就会把别的会话的增量挂到本会话上；
      // - 订阅失败（旧 gateway / 断线 / 参数被拒）时连接同样是全量流，
      //   旧的实现只清 `appliedKey` 而**保留**作用域 ⇒ 一直给别人的帧盖章。
      //
      // 于是这里先置空（进入「无归属」态，帧不会被误挂），订阅成功后再设。
      if (this.eventStore.scopeSessionId !== undefined) this.eventStore.setScopeSession(undefined);
      // **作用域真的变了才清空**（换会话 / 换 Team / chat↔runs）：旧条目属于别的范围，
      // 留着会串台。同一作用域内的重新订阅（重连、gap 重对齐、换过滤参数）**不清空**：
      // 内容原地保留，由 `truncateAfter` + `push` 去重把窗口补回来，屏幕上不会出现空白帧。
      if (this.appliedScopeKey !== null && this.appliedScopeKey !== scopeKey) {
        this.eventStore.clear();
        // 尾部窗口下限属于**上一个**会话/范围：留到新作用域会让 `after_timeline_seq`
        // 越过新会话的 `wal_head`（服务端按 reset 处理，多走一轮）。
        this.tailWindowFloor = 0;
        this.timelineCursorUnavailable = false;
      }
      this.appliedScopeKey = scopeKey;
      if (this.appliedKey === scopeKey) return;
      // ① 回填（只在 chat 且服务端按会话过滤时）：**在实时订阅之前**一次拿全一个区间。
      if (sessionScoped !== undefined) {
        await this.runTimelineBackfill(sessionScoped, scopeKey);
        if (this.desired !== scope) continue;
      }
      // ①.5 读不到时间线游标：本轮**不按 `after_timeline_seq` 订阅**（否则 0 会让服务端
      //     从 seq 1 重放，续拉一路到末尾）。退到有界 hub 尾窗，并把本地游标归零 ——
      //     hub seq 与时间线 seq 不可比，留着旧的只会让下一次订阅越过 `wal_head`。
      const useTimeline = sessionScoped !== undefined && !this.timelineCursorUnavailable;
      if (sessionScoped !== undefined && this.timelineCursorUnavailable) {
        this.eventStore.endTimelineEpoch();
        this.eventStore.truncateAfter(0);
      }
      // ② 回填追平之后才开实时订阅：`since` 取**当前游标**，所以实时流只送增量，
      //    与回填的区间不重叠（「边回填边追平」的形态从结构上不存在）。
      const built = buildSubscription(scope, {
        // chat：回填已经追平，实时流只要增量（游标就是右端）；team / none 沿用连接级
        // hello 给的锚点（它们本来就不重放历史）；runs / run 固定 `since: 0`。
        currentSeq: scope.kind === 'chat' ? this.eventStore.currentSeq : baseSeq,
        sessionFilter: this.supportsSessionFilter(),
      });
      // 时间线订阅的起点 = max(单游标, 尾部窗口左端 - 1)：**回填失败也不从 0 回放**
      // （tail-window 的 (b)）。旧参数那条（`since`，见 `built.filter`）保持原口径：
      // 它跑在 hub 环形 seq 空间里，与这里的尾窗口径不是同一套编号。
      const afterSeq =
        scope.kind === 'chat'
          ? Math.max(this.eventStore.currentSeq, this.tailWindowFloor)
          : this.eventStore.currentSeq;
      // 降级到老参数时 `since` 必须是 hub seq：从 0 起有界回放，不继承时间线游标。
      const legacyFilter =
        sessionScoped !== undefined && !useTimeline ? { ...built.filter, since: 0 } : built.filter;
      this.appliedKey = scopeKey;
      this.clientFilter = built.clientSessionFilter;
      this.pendingHello = 'subscribe';
      try {
        await this.subscribeOnce(
          scopeKey,
          useTimeline ? sessionScoped : undefined,
          afterSeq,
          legacyFilter,
          !useTimeline,
        );
        // 0.60：订阅成功 = 服务端确实按 `session_id` 过滤了（或降级为显式无作用域），
        // 现在盖章才与事实一致。
        this.eventStore.setScopeSession(sessionScoped);
        // 新 gateway 的订阅级 hello 在 res 之前到达，`consumeHello` 已消费；
        // 旧 gateway 不发订阅级 hello，这里清掉在途标记，避免它吞掉下一次
        // 连接级 hello（会导致重连后漏 bump epoch / 漏刷新详情）。
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
      } catch {
        // 旧 gateway / 断线：params 被忽略或请求失败。保留路由意图，
        // 重连后的连接级 hello 会重新 apply；期间订阅退回默认过滤。
        this.appliedKey = null;
        // 0.60：订阅没成 ⇒ 服务端没有会话作用域 ⇒ 作用域必须一起清掉（否则会一直给
        // 别的会话的帧盖本会话的章，见上）。
        this.eventStore.setScopeSession(undefined);
        if (this.pendingHello === 'subscribe') this.pendingHello = null;
      }
      // ③ 服务端宣告了 `reset`（本地游标越过 `wal_head`）：刚才这一趟是从 seq 1 重放的
      //    「空转」，已经丢弃 + 尾部窗口下限挡住。这里重跑一轮：回填会按尾部窗口落位，
      //    再按新的游标订阅（而不是沿着 reset 的段继续往前追）。
      if (this.resetReanchor) {
        this.resetReanchor = false;
        this.timelineCursorUnavailable = false;
        this.appliedKey = null;
        continue;
      }
      // ④ 本趟收尾（`res` 已回）：服务端**发自 0.55 就有** `timeline-epoch-end` 帧，
      //    上面已经结过趟；老服务端（0.54 不发结束帧）/ 服务端撞背压提前停时，`res`
      //    本身就是「这一趟不会再发帧了」的显式事实 —— 按连续前缀收口，需要续拉就在本轮
      //    循环里继续（`run()` 在跑时 `apply()` 会被幂等短路丢掉，所以不能靠它）。
      const settled = this.eventStore.settleTimelineEpochIfOpen();
      if (settled !== undefined && this.advanceEpoch(settled, {})) {
        this.appliedKey = null;
        continue;
      }
      if (this.continuationPending) {
        // 结束帧在 `res` 之前就到了（0.55 的正常顺序），钩子只置了意图。
        this.continuationPending = false;
        this.appliedKey = null;
        continue;
      }
      // 等待期间路由又变了：用新 scope 再跑一轮。
      if (this.desired === scope) return;
    }
  }
}
