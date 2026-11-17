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
 * 3. **失败绝不静默消失。** 15 s 没有任何回显 ⇒ `failed`，气泡留在原地带「重试 / 删除」；
 *    排队（`queued`）虽然不按 15 s 判失败，但 3 分钟还没被认领同样停在 `failed`
 *    （`queued-timeout`）—— 「排队」不是「可以永远不动」的同义词。
 *    重试**复用同一个 id**（不是新开一条 pending，也不是再画一条气泡）。
 *
 * 这一层**不碰** `EventStore` / `LiveItemStore` / `transcript-items.ts`：它只消费事件里
 * 的 `run_id` / `session_id`（`noteEvent`），产出「还该画几条灰气泡」。渲染侧的接缝只有
 * 两个：`TranscriptWindow` 里追加的节点，和 `usePendingSends` 的订阅。
 *
 * @module
 */

import type { MessageRef } from '../../gateway/types';

/**
 * 多久没等到回显就算「发不出去」（毫秒）。
 *
 * 依据是**服务端顺序**，不是拍的：`user.message` 在 `executeRun` 里发布得很早
 * （`loadStoredHistory` 之后、`llm.request` 之前），所以「15 s 还没回显」不可能是
 * 「模型慢」—— 只可能是这条 run 没起来（spawn 失败 / 队列卡住 / 事件流断了）。
 * 阈值取 15 s：远大于正常冷态回显（秒级），又短于用户开始怀疑自己没发出去的时间。
 */
export const PENDING_ECHO_TIMEOUT_MS = 15_000;

/** 扫超时的节拍：1 s 足够（判定阈值是 15 s 量级，不需要更细）。 */
export const PENDING_SWEEP_INTERVAL_MS = 1_000;

/**
 * 排队多久还没被认领就算「这条没发出去」（毫秒）。
 *
 * `queued` 是服务端三条**不会起跑**的路的共用出口（draining / rotate-quiet /
 * hardStop 都 `newId()` 一个 run_id 直接回 `status: 'queued'`，见
 * `packages/agent/src/service.ts` 的 `admitInternal`），加上「回显比 `runs.start`
 * 的返回先到」这个竞态窗口 —— 都不产生任何带该 `run_id` 的事件。0.56 写死「queued
 * 不判超时」时只想到「前面还有一整轮」，漏了「这一轮根本不会来」，于是气泡能停在
 * 「已排队」到天荒地老（用户原话：「已排队，前面还有一轮这个咋还没删呢？」）。
 *
 * 3 分钟的依据：真的排队要等的是**一轮对话**（正常一轮几十秒到一两分钟）。超过 3 分钟
 * 还没被认领，用户需要的是一个能重试 / 删除的出口，而不是继续等。
 */
export const PENDING_QUEUE_TIMEOUT_MS = 3 * 60_000;

/** 「回显先到」的记忆上限：只为了盖住 `runs.start` 那次往返，几条就够。 */
const ECHO_MEMORY_LIMIT = 32;

export type PendingSendState =
  /** 已发出 `runs.start`（或还在等它返回）：正文在飞。 */
  | 'sending'
  /**
   * `runs.start` 说这条**排队**了：等服务端起跑，**不按 15 s 判失败**（前面还有一整轮）。
   * 但它**不是无出口**：3 分钟还没被认领 ⇒ `failed`（`failure: 'queued-timeout'`）。
   */
  | 'queued'
  /** 超时（含排队超时）/ RPC 失败：带着原因留在原地，等「重试 / 删除」。 */
  | 'failed';

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
  state: PendingSendState;
  /**
   * `failed` 时的人话原因：`'timeout'`（15 s 没有回显）、`'queued-timeout'`（排队 3 分钟
   * 仍未被认领）或 RPC 原始错误；`sending` / `queued` 恒为 `undefined`。
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

/** 只算「这条消息已经进了服务端时间线」的两类事件。 */
const ECHO_EVENT_TYPES: readonly string[] = ['user.message', 'run.started'];

/** 兜底认领时的正文比较（guardrail 改写后正文会变，这里只挡「明显不是同一条」）。 */
function sameText(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

/**
 * 内存里的 pending 集合（按会话索引；外部通过 `subscribe` + `list` 取快照）。
 *
 * **无持久化**：刷新即空。这是刻意的 —— 「刷新后只剩一份」的判据由结构保证，而不是由
 * 「记住 pending 再去和服务端对账」的复杂逻辑保证；后者一旦漏掉一次对账就会永久重复。
 */
export class PendingSendStore {
  private items: PendingSend[] = [];
  private readonly listeners = new Set<() => void>();
  private nextSequence = 1;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  /**
   * 已经见过回显、但当时**还没有 pending 挂上这个 run id** 的 run。
   *
   * 存在的理由是一个真实竞态：前面那一轮可能恰好在 `runs.start` 往返期间结束，
   * 于是 `user.message` 先到（那时 pending 还没有 `runId`，认领不到），`attachRun`
   * 后到 —— 水位已经越过那条事件，之后**没有第二次机会**再认领它，气泡就永远停在
   * 「已排队」。这里记下这条回显，`attachRun` 时直接把人摘掉（有界，只留最近几条）。
   */
  private readonly echoedRuns = new Set<string>();
  /**
   * 每条 queued pending 上一次「已等 N 分钟」的整分钟数。
   *
   * 只用来决定**要不要发一次通知让渲染重算**：排队本来不产生任何事件，界面上的
   * 「已排队 2 分钟」得有人推动才会变。不进 `PendingSend`（那是给别人读的实体，
   * 一个纯渲染节拍没有必要变成字段）。
   */
  private readonly queuedMinutes = new Map<string, number>();

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
   * `queued` 的 run 前面还有一整轮在跑，回显本来就该晚 —— 但**不能无限**：3 分钟还没
   * 被认领就走 {@link PENDING_QUEUE_TIMEOUT_MS} 的失败出口（见 `sweep`）。
   *
   * 回显已经先到了（`echoedRuns` 命中）⇒ 这条消息**已经在**服务端时间线上，直接摘掉，
   * 不要挂一个永远等不到回显的 `queued`。
   */
  attachRun(id: string, runId: string, status: string): void {
    if (this.echoedRuns.has(runId)) {
      this.echoedRuns.delete(runId);
      this.remove(id);
      return;
    }
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
    this.queuedMinutes.delete(id);
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
    this.queuedMinutes.clear();
    this.echoedRuns.clear();
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
   *    （「认领只发生一次」是结构性的，不靠计数）。
   */
  noteEvent(event: PendingEchoEvent): string | undefined {
    if (!ECHO_EVENT_TYPES.includes(event.type)) return undefined;
    if (event.runId !== undefined && event.runId !== '') {
      // `run_id` 精确命中对所有态都算（含 `failed`）：那条 run **真的起来了** ⇒ 消息
      // 已经在服务端时间线上，气泡必须让位。少了这一条，「排队超时」之后真起来的 run
      // 会让用户看到「同一条消息两份」（气泡 + 真消息），再点重试就是三份。
      const byRun = this.items.find((item) => item.runId === event.runId);
      if (byRun !== undefined) {
        this.remove(byRun.id);
        return byRun.id;
      }
      // 没有 pending 认领它：多半是「回显先到、`attachRun` 后到」那个竞态窗口（也可能是
      // 别的 agent / 子 run 的回显）。记下有界的 run id，让 `attachRun` 兜住这个窗口。
      this.rememberEcho(event.runId);
      return undefined;
    }
    const candidates = this.items.filter((item) => item.state !== 'failed');
    if (candidates.length === 0) return undefined;
    const queueHead = candidates.find(
      (item) =>
        item.state === 'sending' &&
        (item.sessionId === null ||
          event.sessionId === undefined ||
          item.sessionId === event.sessionId) &&
        (event.text === undefined || sameText(item.text, event.text)),
    );
    if (queueHead === undefined) return undefined;
    this.remove(queueHead.id);
    return queueHead.id;
  }

  /**
   * 扫超时：`sending` 超过 {@link PENDING_ECHO_TIMEOUT_MS} ⇒ `failed`（`failure: 'timeout'`）；
   * `queued` 超过 {@link PENDING_QUEUE_TIMEOUT_MS} ⇒ `failed`（`failure: 'queued-timeout'`）。
   *
   * 为什么 `queued` 也必须有一条出口：服务端有三条路会 `newId()` 一个**永不执行**的
   * `run_id` 并回 `status: 'queued'`（draining / rotate-quiet / hardStop），那三条路上
   * 永远不会有回显；再加上回显抢跑那个竞态，`queued` 就是「等一个不会来的东西」。
   * 停在一个**可处置**的失败态（重试 / 删除）比永远停在「已排队」诚实。
   *
   * 排队**很久**也要有**看得见**的变化：跨过整分钟就让订阅者重算一次「已排队 N 分钟」。
   * 排队本身不产生任何事件，没有这一下，界面会一直显示第一分钟的说法。
   *
   * `failed` 不重复标。返回本次被标失败的条数，供驱动断言。
   */
  sweep(now?: number): number {
    const at = now ?? this.now();
    let failed = 0;
    let notify = false;
    this.items = this.items.map((item) => {
      if (item.state === 'failed') return item;
      const age = at - item.createdAt;
      if (item.state === 'sending') {
        if (age < PENDING_ECHO_TIMEOUT_MS) return item;
        failed += 1;
        notify = true;
        return { ...item, state: 'failed', failure: 'timeout' };
      }
      // queued：排队本身可以很久，但不能没有终点。
      if (age >= PENDING_QUEUE_TIMEOUT_MS) {
        failed += 1;
        notify = true;
        this.queuedMinutes.delete(item.id);
        // `runId` **留着**：那条 run 万一在超时之后真的起来了（排队久了点，或者只是回显
        // 来晚了），`noteEvent` 靠它精确认领，把这条气泡摘掉 —— 不然用户会同时看到
        // 「未发送」和一个真的落了地的消息，点一下重试就是两份。
        return { ...item, state: 'failed', failure: 'queued-timeout' };
      }
      const minutes = Math.floor(age / 60_000);
      if (minutes >= 1 && this.queuedMinutes.get(item.id) !== minutes) {
        this.queuedMinutes.set(item.id, minutes);
        notify = true;
      }
      return item;
    });
    if (failed > 0 || notify) this.emit();
    return failed;
  }

  /** 记下「回显先到」的 run id（有界：只留住最近 {@link ECHO_MEMORY_LIMIT} 条）。 */
  private rememberEcho(runId: string): void {
    if (this.echoedRuns.has(runId)) return;
    this.echoedRuns.add(runId);
    if (this.echoedRuns.size <= ECHO_MEMORY_LIMIT) return;
    const oldest = this.echoedRuns.values().next().value;
    if (oldest !== undefined) this.echoedRuns.delete(oldest);
  }

  /** 只给驱动 / 调试：按条件挑一条（渲染侧用 `list()` 全量）。 */
  find(id: string): PendingSend | undefined {
    return this.items.find((item) => item.id === id);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 单例：Web 壳层只有一条 chat 流（与其它 store 同形态）。 */
export const pendingSends = new PendingSendStore();
