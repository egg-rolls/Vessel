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
 *
 * 控制器在发出 subscribe 请求时置 `pendingHello`；`connection-handlers` 在
 * `onHello` 里用 `consumeHello()` 区分这两种 hello。
 */

import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';

/** 旧 gateway 不识别 `session_id`；用 feature 做版本协商，不用形状探测。 */
export const SESSION_FILTER_FEATURE = 'events.session-filter';

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
export function serverScopedSessionId(built: BuiltSubscription): string | undefined {
  if (built.clientSessionFilter !== undefined) return undefined;
  return built.filter.session_id;
}

export class SubscriptionController {
  /** 最近一次路由请求的订阅；重连后据此重新收敛。 */
  private desired: SubscriptionScope | null = null;
  /** 当前生效过滤的 key（JSON），用于跳过幂等重复订阅。 */
  private appliedKey: string | null = null;
  /** 在途 subscribe：下一个 hello 属于订阅 epoch。 */
  private pendingHello = false;
  /** 串行化订阅请求；期间的新 scope 合并到下一轮。 */
  private running: Promise<void> | null = null;
  private clientFilter: string | undefined;
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
   * `onHello` 用：当前到达的 hello 是否属于一次在途 subscribe。
   * 只会让**下一个** hello 命中；连接级 hello 不受影响。
   */
  consumeHello(): boolean {
    if (!this.pendingHello) return false;
    this.pendingHello = false;
    return true;
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
    this.pendingHello = false;
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
    this.pendingHello = false;
    this.appliedKey = null;
  }

  /** feature gate 降级时 UI 应过滤的 session id；服务端已过滤时为 undefined。 */
  get fallbackSessionId(): string | undefined {
    return this.clientFilter;
  }

  private supportsSessionFilter(): boolean {
    return this.client.protocol?.protocol.features.includes(SESSION_FILTER_FEATURE) ?? false;
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
      const key = JSON.stringify(built.filter);
      if (key === this.appliedKey) return;
      this.appliedKey = key;
      this.clientFilter = built.clientSessionFilter;
      this.pendingHello = true;
      try {
        await this.client.request('events.subscribe', built.filter);
        // 新 gateway 的订阅级 hello 在 res 之前到达，`consumeHello` 已消费；
        // 旧 gateway 不发订阅级 hello，这里清掉在途标记，避免它吞掉下一次
        // 连接级 hello（会导致重连后漏 bump epoch / 漏刷新详情）。
        this.pendingHello = false;
      } catch {
        // 旧 gateway / 断线：params 被忽略或请求失败。保留路由意图，
        // 重连后的连接级 hello 会重新 apply；期间订阅退回默认过滤。
        this.appliedKey = null;
        this.pendingHello = false;
      }
      // 等待期间路由又变了：用新 scope 再跑一轮。
      if (this.desired === scope) return;
    }
  }
}
