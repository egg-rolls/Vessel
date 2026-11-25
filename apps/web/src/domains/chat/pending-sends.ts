/**
 * 本地待确认的「刚发出去的那句话」（0.56 乐观渲染）。
 *
 * 为什么要有它：chat 的发送走 `runs.start`，消息只能等**服务端回显**
 * （`user.message` 事件 / 历史投影）。而回显排在 body spawn 与 `loadStoredHistory` 之后 ——
 * 重启后那两样都要全额付出，于是「输入框已清空、消息列表里什么都没有」能持续几十秒。
 * 这一层在**点击的那一帧**先画一条灰态气泡，回显到了再把它撤掉。
 *
 * 三条硬约束（**写死在类型与函数上，不是注释里的君子协定**）：
 *
 * 1. **合并键是 `runs.start` 返回的 `run_id`，不是正文。** 正文会被 guardrail 改写入库
 *    （`run.started.input` 与用户敲的字可以不同），拿正文当身份 = 改写场景必然重复一条。
 *    没有 `run_id` 的旧服务端才退回「按**队首顺序**认领」，而且**只认领一次**
 *    （`claimedByEcho` + 认领即摘除，第二次到达不可能再认领第二条）。
 * 2. **不进 transcript 持久层。** 它只在内存里活（刷新即消失 ⇒ 「刷新后只剩一份」是
 *    结构性结论，不靠对账）；也**不进 `inputsByRun`** 的认领集合（那是 dup-hunt 的消息
 *    身份，pending 是另一类东西，混进去就会改变「谁认领谁」的语义）。
 * 3. **失败绝不静默消失。** 失败态的落点是**待处理条带**（带「重试 / 编辑」，见
 *    `pending-placement.ts`），不是会话流里的一条灰气泡 —— 用户口径：入队消息的展示
 *    只有「inbox → 发出」这一段。重试**复用同一个 id**（不是新开一条 pending，也不是
 *    再画一条气泡）。
 *    **超时回退已移除（用户裁定：「不太需要」）**：原来「15 s 没回显 / 排队 3 min
 *    没被取用 ⇒ failed」的 sweep 不再被调度 —— 消息在服务端 inbox 里持久化、等被
 *    取用，客户端不替服务端宣判失败。失败态只剩一条来路：`runs.start` RPC 明确失败
 *    （`markFailed`）。`sweep` 与 `busySessions` 闸保留在 store 里（驱动 / 调试），
 *    超时类失败码（`timeout` / `queue_timeout` / `defer_timeout`）的回显认领兼容也保留。
 *    0.57 起服务端还有第三种应答 `deferred`（**收下了、但这一轮不会起跑、没有 run id**，
 *    见 `pending-placement.ts` 与 `AdmitResult`）：它同样只在条带上，靠回显认领或
 *    用户动作（重试会先撤回服务端那份）收口，不再按计时转失败。
 *
 * 这一层**不碰** `EventStore` / `LiveItemStore` / `transcript-items.ts`：它只消费事件里
 * 的 `run_id` / `session_id` / `message_id`（`noteEvent` / `noteQueued`），产出「这条消息现在
 * 在哪个状态」。渲染侧的接缝有两个：`pending-placement.ts`（**唯一**决定「画在哪」的地方）
 * 与 `usePendingSends` 的订阅。
 *
 * 0.56 排队生命周期（用户口径）：`sending` 在会话里、`queued` 只在条带、`sent` 之后条带那条
 * 必须消失、`failed` 回流到条带带「重试 / 编辑」。三个状态与三处展示的映射全部由
 * `pending-placement.ts` 给出，本文件只负责**状态本身**怎么变。
 *
 * @module
 */

import type { MessageRef } from '../../gateway/types';

/**
 * 多久没等到回显就算「发不出去」（毫秒）。
 *
 * **运行期已不再使用（用户裁定移除超时 sweep）**：保留给 store 的 `sweep`
 * （驱动 / 调试口径）。原依据是**服务端顺序**：`user.message` 在 `executeRun` 里
 * 发布得很早（`loadStoredHistory` 之后、`llm.request` 之前），「15 s 还没回显」
 * 只可能是 run 没起来 —— 但用户裁定客户端不该替服务端宣判失败，消息在 inbox 里等。
 */
export const PENDING_ECHO_TIMEOUT_MS = 15_000;

/** 扫超时的节拍：1 s。**运行期已无消费者**（sweep 不再被调度），保留给驱动 / 调试。 */
export const PENDING_SWEEP_INTERVAL_MS = 1_000;

/**
 * 排队多久没被 run 取用就算「排队超时」（毫秒）：3 分钟。
 *
 * **运行期已不再使用（用户裁定移除超时 sweep）**：排队消息在服务端 inbox 里持久化、
 * 等被取用，前面那一轮跑多久都正常，客户端不再按计时收敛成失败。保留给 store 的
 * `sweep`（驱动 / 调试口径，含 `busySessions` 闸）。
 */
export const PENDING_QUEUE_TIMEOUT_MS = 180_000;

/**
 * `deferred` 多久还没被接单就转成「未发送 · 等待接单超时」（毫秒）：3 分钟（同排队口径）。
 *
 * **运行期已不再使用（用户裁定移除超时 sweep）**：`deferred`（服务端已收下、这一轮
 * 没起跑）靠回显认领或用户动作收口，不再按计时转失败。保留给 store 的 `sweep`
 * （驱动 / 调试口径）。重试仍会**先撤回服务端那份**再重发（见 `PendingStrip` 的
 * `retryRow`），不会变成两份。
 */
export const PENDING_DEFER_TIMEOUT_MS = 180_000;

export type PendingSendState =
  /** 已发出 `runs.start`（或还在等它返回）：正文在飞。 */
  | 'sending'
  /** `runs.start` 说这条**排队**了：等服务端起跑，**不按计时判失败**（超时 sweep 已移除，消息在 inbox 里等被取用）。 */
  | 'queued'
  /**
   * `runs.start` 回 `deferred`（0.57）：服务端**收下了**、但这一轮没起跑，**没有 run id**。
   *
   * 三条路：`draining`（进程在退出，消息留在收件箱）/ `rotate`（body 换代，消息落在收件箱，
   * **不会**自动变成一轮 run）/ `stopped`（硬错误闸，解闸后自动重投）。这条 pending 没有
   * run id 可对，所以靠「同会话 + 同一句正文」的 `run.started` 认领（见 `noteEvent`）；
   * 超时 sweep 移除后不再按计时转失败 —— 认领不到就一直在条带上等（用户可重试 / 删除）。
   */
  | 'deferred'
  /** RPC 明确失败（超时回退已移除）：带着原因留在原地，等「重试 / 删除」。 */
  | 'failed';

/**
 * 为什么服务端没接单（`runs.start` 的 `reason`，稳定码）。
 *
 * 未知值也不崩：文案映射对未知 reason 走通用那一句（见 `deferReasonText`）。
 */
export type PendingSendDeferReason = 'draining' | 'rotate' | 'stopped';

export interface PendingSend {
  /** 本条 pending 的稳定 id（重试复用同一个）。 */
  id: string;
  /** 归属会话；草稿态新建会话时先为 `null`，`sessions.create` 返回后补上。 */
  sessionId: string | null;
  /** 用户敲的原文（**只用于显示与重发**，不参与身份判定）。 */
  text: string;
  /** 附件引用（与正文一起重发）。 */
  refs?: readonly MessageRef[];
  /** 创建时刻（毫秒）：超时判定基准。重试会刷新它。 */
  createdAt: number;
  /**
   * `runs.start` 返回的 run id —— **首选合并键**。
   *
   * 有它就能精确对齐回显（`user.message` 的 `run_id` 与它同源），与正文是否被改写无关。
   */
  runId?: string;
  /**
   * 服务端那条**队列条目**的 id（`agent.message.queued` 事件的 `message_id`，0.56）。
   *
   * 它是「这条 pending」与「条带上那一行 / 服务端 inbox 里那一条」的**同一个身份**：
   * 有了它，条带就能精确地让客户端那行顶替服务端那行（见 `pending-placement.ts` 的
   * `claimsEntry`），而不用靠正文猜。
   *
   * 缺省 = 还没收到事件 / 旧 gateway 不带；此时按「同会话 + human 源 + 摘要同口径」兜底。
   */
  messageId?: string;
  state: PendingSendState;
  /**
   * `deferred` 时服务端给的原因（`draining` / `rotate` / `stopped`，未知值原样保留）。
   * 只在条带卡头的文案映射里用；其余状态恒为 `undefined`。
   */
  deferredReason?: string;
  /**
   * `deferred` 时服务端建议的重问间隔（毫秒）。缺省 = 不是时间问题（`stopped` 要人工动作）。
   */
  retryAfterMs?: number;
  /**
   * `failed` 时的人话原因；`sending` / `queued` / `deferred` 恒为 `undefined`。
   *
   * 运行期只来自 RPC / 断线的原始说明（`markFailed`）。超时类码（`'timeout'` /
   * `'queue_timeout'` / `'defer_timeout'`）随超时 sweep 移除不再产生，但文案映射与
   * 回显认领兼容保留（见 `PendingStrip` / `PendingBubble` 与 {@link isTimeoutFailure}）。
   */
  failure?: string;
}

/** 回显事件的**判别依据**：只认这几个字段，别的一概不读。 */
export interface PendingEchoEvent {
  /** 事件所属 run（`run.started` / `user.message` 都带）。 */
  runId?: string;
  /** 事件所属会话（老服务端 / 别名场景可能缺）。 */
  sessionId?: string;
  /** 事件类型：只认 `run.started` / `user.message`（其它事件不代表「消息已经进时间线」）。 */
  type: string;
  /** 回显正文（可选）：**只**用在没有 `run_id` 的兜底认领里，用来少认错一条。 */
  text?: string;
}

/** 记住多少个「已经发出去」的 `message_id`（见 `sentMessageIds`）。 */
const SENT_MEMORY_MAX = 32;

/** 只算「这条消息已经进了服务端时间线」的两类事件。 */
const ECHO_EVENT_TYPES: readonly string[] = ['user.message', 'run.started'];

/** 兜底认领时的正文比较（guardrail 改写后正文会变，这里只挡「明显不是同一条」）。 */
function sameText(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

/**
 * 「超时类」失败码：这三种失败的正文**都可能已被服务端收下**（`sending` 的 RPC 在飞 /
 * `queued` 明确排进了队列 / `deferred` 明确收下了），所以迟到的回显必须能把它们认领掉
 * （见 {@link PendingSendStore.noteEvent}）。其余失败（RPC 错 / 断线）服务端没收到，不认。
 */
const TIMEOUT_FAILURES: readonly string[] = ['timeout', 'queue_timeout', 'defer_timeout'];

function isTimeoutFailure(failure: string | undefined): boolean {
  return failure !== undefined && TIMEOUT_FAILURES.includes(failure);
}

/**
 * 内存里的 pending 集合（按会话索引；外部通过 `subscribe` + `list` 取快照）。
 *
 * **无持久化**：刷新即空。这是刻意的 —— 「刷新后只剩一份」的判据由结构保证，而不是由
 * 「记住 pending 再去和服务端对账」的复杂逻辑保证；后者一旦漏掉一次对账就会永久重复。
 */
export class PendingSendStore {
  private items: PendingSend[] = [];
  /** 已被服务端取用（回显到达）的 `message_id`，见 {@link sentMessageIds}。 */
  private sentIds: string[] = [];
  private readonly listeners = new Set<() => void>();
  private nextSequence = 1;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options?: { now?: () => number; idFactory?: () => string }) {
    this.now = options?.now ?? (() => Date.now());
    this.idFactory =
      options?.idFactory ??
      (() => {
        const seq = this.nextSequence;
        this.nextSequence += 1;
        // 客户端唯一即可：不跨设备、不落盘、不参与服务端身份。
        return `pending-${String(this.now())}-${String(seq)}`;
      });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** `useSyncExternalStore` 的快照：数组身份只在真正变化时换（否则每帧重渲染）。 */
  list = (): readonly PendingSend[] => this.items;

  /** 建一条 pending（点击的那一帧）；返回 id 供后续 attach / 失败 / 重试。 */
  create(input: {
    sessionId: string | null;
    text: string;
    refs?: readonly MessageRef[];
    reuseId?: string;
  }): string {
    const id = input.reuseId ?? this.idFactory();
    const at = this.now();
    if (input.reuseId !== undefined) {
      // 重试：**同一个 id** 回到 sending 态，正文 / 引用可能被用户改过（以新值为准）。
      this.items = this.items.map((item) =>
        item.id === id
          ? {
              ...item,
              text: input.text,
              ...(input.refs !== undefined ? { refs: input.refs } : {}),
              createdAt: at,
              state: 'sending',
              failure: undefined,
              runId: undefined,
              deferredReason: undefined,
              retryAfterMs: undefined,
              // 重试前 `PendingStrip` 已经把服务端那条旧消息撤掉了（`recall`），那个
              // `messageId` 已经不存在；留着它会让新的 `agent.message.queued` 挂不上
              // （`noteQueued` 只认还没有身份的那条），条带于是认领不到新行。
              messageId: undefined,
            }
          : item,
      );
      this.emit();
      return id;
    }
    this.items = [
      ...this.items,
      {
        id,
        sessionId: input.sessionId,
        text: input.text,
        ...(input.refs !== undefined ? { refs: input.refs } : {}),
        createdAt: at,
        state: 'sending',
      },
    ];
    this.emit();
    return id;
  }

  /** 草稿态新建会话：`agents.create` 回来才知道 session id（只补空值，不覆盖已有）。 */
  attachSession(id: string, sessionId: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id || item.sessionId !== null) return item;
      changed = true;
      return { ...item, sessionId };
    });
    if (changed) this.emit();
  }

  /**
   * `runs.start` 返回：挂上**首选合并键**。
   *
   * `queued` 的 run 前面还有一整轮在跑，回显本来就该晚 —— 这种 pending 不按计时判失败
   * （超时 sweep 已移除，见模块头）。
   */
  attachRun(id: string, runId: string, status: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      return {
        ...item,
        runId,
        state: status === 'queued' ? 'queued' : 'sending',
        failure: undefined,
      };
    });
    if (changed) this.emit();
  }

  /**
   * 服务端队列条目的 id 落定（`agent.message.queued` 事件，0.56）。
   *
   * 这是「客户端这一条」与「服务端 inbox 里那一条」共用的身份：条带据此精确顶替
   * （`pending-placement.ts#claimsEntry`），「一条消息只在一处」就不再依赖正文比对。
   * 缺省没有它时的兜底路径见那个文件。
   */
  attachMessage(id: string, messageId: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id || item.messageId === messageId) return item;
      changed = true;
      return { ...item, messageId };
    });
    if (changed) this.emit();
  }

  /**
   * 吃一条「消息进队列」的事件：把服务端 `message_id` 挂到**本会话最早的一条还没身份的
   * pending** 上。
   *
   * 为什么按「最早」：`admit` 是顺序的（一条 pending 一次 `runs.start`），事件也是顺序的，
   * 所以第 N 个 `agent.message.queued` 就属于第 N 条还没有身份的 pending。这也是
   * `noteEvent` 兜底认领的那条「队首顺序」规则的同族写法。
   *
   * 只认人类来源（`from === 'human'`）：agent / ask / bash 作业的条目也走同一种事件，
   * 把它们认成「我刚发的那句」会让条带顶替掉不该顶替的行。
   *
   * 返回被认领的 pending id（没有命中 ⇒ `undefined`），供驱动断言「到底认领了谁」。
   */
  noteQueued(claim: {
    messageId: string;
    sessionId?: string;
    from?: string;
    delivery?: string;
  }): string | undefined {
    // 只认人类的直接输入：其余投递不是「我按了发送」。
    if (claim.from !== 'human' || claim.delivery !== 'input') return undefined;
    const candidate = this.items.find(
      (item) =>
        item.messageId === undefined &&
        item.state !== 'failed' &&
        (item.sessionId === null ||
          claim.sessionId === undefined ||
          item.sessionId === claim.sessionId),
    );
    if (candidate === undefined) return undefined;
    this.attachMessage(candidate.id, claim.messageId);
    return candidate.id;
  }

  /**
   * `runs.start` 回 `status: 'deferred'`（0.57）：服务端**收下了**，但这一轮不会起跑。
   *
   * draining / rotate / stopped 三条路都**不回 run id**（以前那里是一个永不执行的假号）。
   * 所以这里不挂 `runId`（挂了就永远等不到回显），只记原因 / 建议间隔 / 消息 id；
   * 之后靠「同会话 + 同一句正文」的 `run.started` 认领（见 {@link noteEvent}）。
   *
   * `messageId` 只在服务端给了的时候写：它可能已经从 `agent.message.queued` 事件先到
   * （`noteQueued`），那边写过的值不被覆盖成 `undefined`。
   *
   * 不重置 `createdAt`：条带上的「等了多久」是用户视角从点击那一刻算的。
   */
  attachDeferred(
    id: string,
    info: { reason?: string; retryAfterMs?: number; messageId?: string },
  ): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      return {
        ...item,
        state: 'deferred',
        runId: undefined,
        failure: undefined,
        ...(info.reason !== undefined ? { deferredReason: info.reason } : {}),
        ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
        ...(info.messageId !== undefined ? { messageId: info.messageId } : {}),
      };
    });
    if (changed) this.emit();
  }

  /** RPC 直接失败（断网 / 准入闸门拒绝）：立刻进失败态，**不**等 15 s。 */
  markFailed(id: string, reason: string): void {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      return { ...item, state: 'failed', failure: reason, runId: undefined };
    });
    if (changed) this.emit();
  }

  /** 用户点「删除」：这条 pending 从屏上消失（服务端没收到任何东西，不会留下孤儿）。 */
  remove(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  }

  /** 切走会话 / 断开连接：清掉某个会话的 pending（它们已无回显可等）。 */
  clearSession(sessionId: string | null): void {
    const next = this.items.filter((item) => item.sessionId !== sessionId);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  }

  reset(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  /**
   * 吃一条事件：命中就撤掉对应的 pending（**回显即地面真相，撤掉之后屏上只剩服务端那份**）。
   *
   * 返回被撤掉的 pending id（没有命中 ⇒ `undefined`），调用方**不需要**用它做什么，
   * 它存在是为了让驱动验证 / 调试能断言「到底撤了谁、撤了几次」。
   *
   * 判定顺序（先后不能换）：
   * 1. `run_id` 精确命中 ⇒ 直接撤（正文被 guardrail 改写也照样命中，这是首选路径）；
   * 2. 没有 `run_id`（旧服务端 / 别名）：只在**同会话**里按**队首顺序**认领一条
   *    `sending` 且正文相同的 pending；认领即撤，所以同一条回显**不可能**认领第二次
   *    （「认领只发生一次」是结构性的，不靠计数）；
   * 3. 上面两条都不中时，再看有没有 `deferred` / **超时类失败**的 pending 等这句话
   *    （见 {@link claimByEchoText}）。
   *
   * **超时类失败（`timeout` / `queue_timeout` / `defer_timeout`）也在候选里**：它们的正文
   * 可能已被服务端收下，只是客户端先判了失败。回显一到，那条失败行必须让位给会话里那条
   * 真消息 —— 否则屏上同时有「未发送 · 已超时」和一条正常气泡 = 同一条消息两份
   * （用户报的 bug）。其余失败（RPC 错 / 断线）服务端没收到，不参与认领。
   */
  noteEvent(event: PendingEchoEvent): string | undefined {
    if (!ECHO_EVENT_TYPES.includes(event.type)) return undefined;
    if (this.items.length === 0) return undefined;
    const candidates = this.items.filter(
      (item) => item.state !== 'failed' || isTimeoutFailure(item.failure),
    );
    if (event.runId !== undefined && event.runId !== '') {
      const byRun = candidates.find((item) => item.runId === event.runId);
      if (byRun === undefined) {
        // 没有 pending 挂这个 run id。**先**看有没有 `deferred` / 超时类失败的 pending
        // 等这句话：服务端明确不回 run id（deferred）或失败时没挂上 run id，这条回显
        // 就是「它终于起跑了」的唯一信号（`run.started.input` 是改写前的原文，正好等于
        // 用户敲的字）。
        return this.claimByEchoText(event);
      }
      // 记住「这条真的发出去了」：条带那份缓存读数据此立刻滤掉旧行（不等下一次轮询）。
      this.noteSent(byRun.messageId);
      this.remove(byRun.id);
      return byRun.id;
    }
    const queueHead = candidates.find(
      (item) =>
        item.state === 'sending' &&
        (item.sessionId === null ||
          event.sessionId === undefined ||
          item.sessionId === event.sessionId) &&
        (event.text === undefined || sameText(item.text, event.text)),
    );
    if (queueHead === undefined) return this.claimByEchoText(event);
    this.noteSent(queueHead.messageId);
    this.remove(queueHead.id);
    return queueHead.id;
  }

  /**
   * 按「同会话 + 同一句正文」认领一条 `deferred` / **超时类失败**的 pending，
   * 且事件必须真的带正文。
   *
   * 为什么必须有一条这样的退路：`deferred` 的 pending 没有 run id（服务端明确不回），
   * 超时类失败的 pending 也可能没挂上 run id（`sending` 在 `runs.start` 返回前就超时），
   * 于是「按 run_id 精确认领」这条首选路径对它们不成立；不按正文认领一次，这条 pending
   * 就只能永远停在失败态 —— 而消息其实早就进了会话（用户会看到「未发送 · 已超时」+
   * 「那条真消息」两份）。
   *
   * 为什么安全：只认 `run.started` / `user.message`（`ECHO_EVENT_TYPES` 已限）、只认同会话、
   * 正文相等，并且**认领即摘除** —— 「最多认领一次」是结构性的，不靠计数。正文相等这种弱
   * 身份只在「没有强身份可用」时启用，与 0.56 的队首兜底认领是同一档。
   *
   * 超时类失败（`timeout` / `queue_timeout` / `defer_timeout`）都认：它们的正文确实可能
   * 被服务端收下了（`queued` / `deferred` 的语义就是「收下了」，`sending` 的 RPC 可能在飞），
   * 所以「同会话 + 同一句正文」的 run 起来时它必须让位 —— 否则用户会同时看到「未发送」
   * 和一条真消息，再点重试就是两份（重试会先撤回服务端那份，但已经落地的那条撤不回来）。
   * 别的原因的 `failed` 不认（RPC 失败那条服务端根本没收到）。
   */
  private claimByEchoText(event: PendingEchoEvent): string | undefined {
    if (event.text === undefined) return undefined;
    const hit = this.items.find(
      (item) =>
        (item.state === 'deferred' ||
          (item.state === 'failed' && isTimeoutFailure(item.failure))) &&
        (item.sessionId === null ||
          event.sessionId === undefined ||
          item.sessionId === event.sessionId) &&
        sameText(item.text, event.text ?? ''),
    );
    if (hit === undefined) return undefined;
    this.noteSent(hit.messageId);
    this.remove(hit.id);
    return hit.id;
  }

  /**
   * 扫超时：三个口径，**都往 `failed` 收**（失败态永远带着出口，永不静默消失）。
   *
   * **运行期已不再被调度（用户裁定：「不太需要」）**：唯一的驱动
   * （`usePendingSends` 的 1 s interval）已移除 —— 排队 / 回显超时整个不再触发，
   * 消息在服务端 inbox 里持久化、等被取用。本方法与 `busySessions` 闸原样保留，
   * 供驱动验证 / 调试按旧口径断言；运行期失败态只来自 `markFailed`（RPC 明确失败）。
   *
   * - `sending` 超过 {@link PENDING_ECHO_TIMEOUT_MS}（15 s）⇒ `failure: 'timeout'`；
   * - `queued` 超过 {@link PENDING_QUEUE_TIMEOUT_MS}（3 min）⇒ `failure: 'queue_timeout'`
   *   —— 文案是「未发送 · 排队超时」，同样是可重试 / 可编辑的失败，不是另一种展示位置；
   * - `deferred` 超过 {@link PENDING_DEFER_TIMEOUT_MS}（3 min）⇒ `failure: 'defer_timeout'`
   *   —— 服务端**收下了**但一直没接单（`stopped` 那条要等人工动作，可能永远等不到）。
   *
   * **`busySessions` 闸（用户裁决）**：调度器对某个会话还有在飞工作（`running` / `queued`，
   * 权威来源 `health.get.runtime.scheduler`）时，那个会话的 `sending` / `queued` pending
   * **不判超时** —— agent 还在尝试（没抛错、还在跑），单纯计时到点不构成「发不出去」的
   * 结论。一轮 run 跑 10 分钟，排在它后面的消息等 10 分钟是**正常**，不是失败。只有调度器
   * 对这个会话**没有任何在飞工作**（run 结束 / 失败 / 被取消，而消息还没被取用）时，
   * 计时才收敛成失败态 —— 那才是「实在不能解决的问题」。`deferred` 不受此闸：服务端
   * 明确说了这一轮不起跑（draining / rotate / stopped），不属于「还在尝试」。
   * 缺省（不传）= 旧行为，纯计时。
   *
   * `failed` 不重复标。返回本次被标失败的条数，供驱动断言。
   */
  sweep(now?: number, busySessions?: ReadonlySet<string>): number {
    const at = now ?? this.now();
    let failed = 0;
    this.items = this.items.map((item) => {
      // agent 仍在尝试：调度器对这个会话还有在飞工作 ⇒ 不判超时（见上）。
      if (
        busySessions !== undefined &&
        item.sessionId !== null &&
        (item.state === 'sending' || item.state === 'queued') &&
        busySessions.has(item.sessionId)
      ) {
        return item;
      }
      const budget =
        item.state === 'sending'
          ? PENDING_ECHO_TIMEOUT_MS
          : item.state === 'queued'
            ? PENDING_QUEUE_TIMEOUT_MS
            : item.state === 'deferred'
              ? PENDING_DEFER_TIMEOUT_MS
              : undefined;
      if (budget === undefined) return item;
      if (at - item.createdAt < budget) return item;
      failed += 1;
      return {
        ...item,
        state: 'failed',
        failure:
          item.state === 'queued'
            ? 'queue_timeout'
            : item.state === 'deferred'
              ? 'defer_timeout'
              : 'timeout',
      };
    });
    if (failed > 0) this.emit();
    return failed;
  }

  /** 只给驱动 / 调试：按条件挑一条（渲染侧用 `list()` 全量）。 */
  find(id: string): PendingSend | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * 已经**被服务端取用**（回显到达）的那些服务端 `message_id`（最近 32 条）。
   *
   * 为什么 store 还要记住它们：pending 一被摘掉，条带那边就没有「认领者」了，而它手里那份
   * `agents.inbox` 读数是**上一次轮询的缓存**（最长 2 s）—— 那段时间屏上会同时出现
   * 「会话里的正常气泡」和「条带上那条旧的排队行」= 又是同一条消息两份。
   * 所以「这条已经发出去过」这个事实要留在这里，让条带立刻把那条旧读数滤掉（不等下一次轮询）。
   *
   * 只留 id、有上限：这是抑制重复用的短期记忆，不是对账账本。
   */
  sentMessageIds = (): readonly string[] => this.sentIds;

  /** 记一条「它已经发出去了」（只在真正被取用时；RPC 失败那条永远进不来）。 */
  private noteSent(messageId: string | undefined): void {
    if (messageId === undefined) return;
    if (this.sentIds.includes(messageId)) return;
    this.sentIds = [...this.sentIds, messageId].slice(-SENT_MEMORY_MAX);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 单例：Web 壳层只有一条 chat 流（与其它 store 同形态）。 */
export const pendingSends = new PendingSendStore();
