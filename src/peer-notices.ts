/**
 * 成员停下的 peer 通知（`runtime.notice`，scope `peer`）。
 *
 * 0.41 之前成员的收口结论由 `AgentService.deliverToParent` 自动回传给父级；那条通路
 * 已删除（成员自己的报告才是权威，忘了父级可以自己读）。**「停了」这个信号仍然要
 * 让父级知道**，否则父级只能靠轮询。这里把它做成环境信息，而不是正文投递：
 *
 * - 上游是 `AgentService` 的 `peerStops` 端口：它只在「真的停了」时报（见 service.ts
 *   的 `schedulePeerStop` / `flushPeerStop`），本模块不重做那个判定；
 * - 本模块负责**投递语义**：`to` 定向到父 session（总线按 session 游标注入，定向
 *   才不会先跑起来的别的 session 吃掉）、窗口内合并成一条、同一父 session 一轮
 *   （两次 run 之间）最多 1 条；
 * - 不发新事件类型：就是 `runtime.notice` 加一个 scope，模型侧仍走既有
 *   `runtime-notice-hook` 的 `vessel:notice` 尾消息。
 *
 * 窗口放在这里而不是 service：service 只会给「成员停下」这一件事排队，而合并要跨
 * 成员（同一父级下多个成员同时停下），只有拿到全量变更的地方才能合并。
 *
 * @module vessel/peer-notices
 */

import type { EventStream, Logger, RunEvent } from '../packages/core/src/index';
import {
  NOTICE_DETAILS_MAX,
  NOTICE_SUMMARY_MAX,
  type RuntimeNotice,
  type RuntimeNoticeBus,
} from './runtime-notice';

/**
 * 合并 / 判定窗口：第一条变更进来后等这么久，父 session 仍空闲才发。
 *
 * 2s 的取值理由：成员停下后父级马上收到下一条消息是常态（链式派活的最后一跳），
 * 窗口太短会把「停了」和「马上又开工」分两次报出来，等于噪音；再长则父级已经
 * 开始下一轮，通知错过这一轮。
 */
export const PEER_NOTICE_WINDOW_MS = 2000;

/** 单个父 session 最多缓冲的变更条数（超出丢最旧：新事件更有信息量）。 */
const MAX_BUFFERED_CHANGES = 24;
/** 跟踪的父 session 上限（超出丢最旧；只影响合并的精细度，不影响正确性）。 */
const MAX_TRACKED_SESSIONS = 200;

/** 成员停下 / 被关闭的四种结局。 */
export type PeerStopKind = 'completed' | 'failed' | 'cancelled' | 'closed';

/**
 * 一条成员停下的结构化变更（`AgentService.peerStops` 的载荷）。
 *
 * 只在父 session 已知时产生：peer 成员（owner=self、无 parent）没有父级，不产生变更。
 */
export interface PeerStopChange {
  /** 注入目标：父成员当前 primary body 的 session id */
  parent_session_id: string;
  agent_id: string;
  /** 展示名（有就用它，否则用 id） */
  name?: string;
  kind: PeerStopKind;
  /** 失败原因（一行原文；展示时优先取稳定 code） */
  error?: string;
}

export interface PeerNoticeRouterOptions {
  /** 通知总线（定向发布：`{ to: parent_session_id }`） */
  bus: Pick<RuntimeNoticeBus, 'publish'>;
  /** 父运行时事件流：用来判定「这一轮结束了没有」 */
  events?: EventStream;
  logger?: Logger;
  /**
   * 父 session 的**重解析口**（0.53 notice-rotate）。
   *
   * 变更上的 `parent_session_id` 是**报告时刻**父成员 primary body 的 session —— 那一刻
   * 是对的，但 2s 合并窗口内父级若 rotate，新 body 是另一个 session，按旧 session
   * 定向就只落在旧 body 的游标上（新 body 永远拉不到，等于丢给旧 body）。
   *
   * 入参 `memberId` 是上报这条变更的成员（即 `PeerStopChange.agent_id`）：它是通向父级
   * 的那根链接，装配层据此取父成员当前的 primary body session（见 `currentBindingSession`）。
   * 真正投递那一刻（`flush`）才调用，不在 report 时刻缓存结果。
   *
   * 返回 `undefined` / 空串（成员已关、记录不在）或未注入本口（旧装配）时**退回**报告
   * 时刻的 session —— 向后兼容，绝不因此丢通知。
   */
  resolveParentSession?: (memberId: string) => string | undefined;
  /** 窗口；缺省 `PEER_NOTICE_WINDOW_MS` */
  windowMs?: number;
  /** 测试注入。 */
  timers?: {
    set: (fn: () => void, ms: number) => TimerHandle;
    clear: (handle: TimerHandle) => void;
  };
}

export interface PeerNoticeRouter {
  /** 收一条变更：窗口内合并，父 session 空闲时发一条定向 notice。 */
  report(change: PeerStopChange): void;
  /** 已缓冲、尚未发出的变更条数（诊断用） */
  pendingCount(): number;
  /** 取消定时器与订阅（进程关闭 / 测试）。 */
  stop(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface SessionState {
  changes: PeerStopChange[];
  timer?: TimerHandle;
  /** 本轮（这次 run 间隔）已经发过一条；缓冲区留到下一轮 */
  sentInRound: boolean;
  /**
   * 这个窗口里最后上报的成员 id：`flush` 时用它重解析父级当前的 session
   * （rotate 的同步链接；见 `resolveParentSession`）。
   */
  anchor?: string;
}

export function createPeerNoticeRouter(options: PeerNoticeRouterOptions): PeerNoticeRouter {
  const bus = options.bus;
  const logger = options.logger;
  const windowMs = options.windowMs ?? PEER_NOTICE_WINDOW_MS;
  const setTimer =
    options.timers?.set ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      unref(handle);
      return handle;
    });
  const clearTimer = options.timers?.clear ?? ((handle: TimerHandle) => clearTimeout(handle));

  const sessions = new Map<string, SessionState>();
  /** 正在跑的 session（由父运行时事件流维护） */
  const running = new Set<string>();

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      // 刷新 LRU 位置：Map 的插入序就是淘汰序
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionState = { changes: [], sentInRound: false };
    sessions.set(sessionId, created);
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      const stale = sessions.get(oldest.value);
      if (stale?.timer !== undefined) clearTimer(stale.timer);
      sessions.delete(oldest.value);
    }
    return created;
  };

  /**
   * 报告时刻的 session → **现在该投的** session。
   *
   * 只有注入了解析口才动；解析不到（成员已关 / 记录不在 / 抛错 / 空串）一律退回报告
   * 时刻的 session —— 旧装配和「成员刚好被关」都保持既有行为，不丢通知。
   */
  const resolveTarget = (sessionId: string, state: SessionState): string => {
    const resolve = options.resolveParentSession;
    if (resolve === undefined) return sessionId;
    const anchor = state.anchor;
    if (anchor === undefined) return sessionId;
    try {
      const resolved = resolve(anchor);
      return resolved !== undefined && resolved !== '' ? resolved : sessionId;
    } catch (error) {
      logger?.warn('peer_notice.resolve_failed', {
        session_id: sessionId,
        member_id: anchor,
        error: error instanceof Error ? error.message : String(error),
      });
      return sessionId;
    }
  };

  /**
   * 父级在窗口内 rotate 过：把旧 session 上缓冲的变更挪到新 session 的状态上。
   *
   * 必须真的换 key（而不是只把 `to` 改掉）：判忙（`running`）和「一轮最多一条」
   * 都按 session 记账，留在旧 key 上就永远等不到新 body 的 run 收口事件。
   */
  const rekey = (from: string, state: SessionState, to: string): SessionState => {
    const changes = state.changes;
    const anchor = state.anchor;
    state.changes = [];
    sessions.delete(from);
    const next = stateFor(to);
    if (anchor !== undefined) next.anchor = anchor;
    for (const change of changes) pushChange(next, change);
    return next;
  };

  const flush = (sessionId: string, state: SessionState): void => {
    state.timer = undefined;
    if (state.changes.length === 0) return;
    // 真正投递这一刻才重解析：窗口内父级 rotate 过，就投给新 body（旧 body 的游标
    // 新 body 拉不到）。
    const target = resolveTarget(sessionId, state);
    const live = target === sessionId ? state : rekey(sessionId, state, target);
    if (live.changes.length === 0) return;
    // 本轮还在跑：留在缓冲区。状态已经挂在新 session 上，收口事件按新 session 就能找到它。
    if (running.has(target)) return;
    // 新 body 这一轮已经发过一条：留到下一轮（「每轮最多一条」跟着 session 走）。
    if (live.sentInRound) return;
    // 目标状态自己还压着一个窗口：交给它把这两批一起发，不抢跑。
    if (live.timer !== undefined) return;
    const changes = live.changes;
    live.changes = [];
    try {
      const members = peerNoticeMembers(changes);
      bus.publish(buildPeerNotice(changes), {
        to: target,
        ...(members.length > 0 ? { meta: { members } } : {}),
      });
      live.sentInRound = true;
    } catch (error) {
      logger?.warn('peer_notice.publish_failed', {
        session_id: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const schedule = (sessionId: string, state: SessionState): void => {
    // 一个 session 同时最多一个待发窗口（不叠加定时器）。
    if (state.timer !== undefined) return;
    // 本轮还在跑：等 run 收口（那一刻父级才是「看完这一轮」的状态）。判忙用的是
    // **重解析后**的 session：窗口内 rotate 过的话，忙的是新 body，不是旧的那个。
    if (running.has(resolveTarget(sessionId, state))) return;
    state.timer = setTimer(() => {
      state.timer = undefined;
      flush(sessionId, state);
    }, windowMs);
  };

  const unsubscribe = options.events?.subscribe((event: RunEvent) => {
    const sessionId = sessionIdOf(event);
    if (sessionId === undefined) return;
    if (event.type === 'run.started') {
      running.add(sessionId);
      return;
    }
    if (!isRunTerminal(event.type)) return;
    running.delete(sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return;
    // 一轮结束 = 下一轮可以再发一条；缓冲的变更在这条边界之后合并发出。
    state.sentInRound = false;
    if (state.changes.length > 0) schedule(sessionId, state);
  });

  return {
    report(change) {
      if (change.parent_session_id === '' || change.agent_id === '') return;
      const state = stateFor(change.parent_session_id);
      // 记下这根的链接：flush 时用它重解析父级当前的 session（rotate 同步链接）。
      state.anchor = change.agent_id;
      pushChange(state, change);
      // 本轮已发过：留到这一轮结束（run 收口）再发，保证「一轮最多一条」。
      if (state.sentInRound) return;
      schedule(change.parent_session_id, state);
    },
    pendingCount() {
      let total = 0;
      for (const state of sessions.values()) total += state.changes.length;
      return total;
    },
    stop() {
      for (const state of sessions.values()) {
        if (state.timer !== undefined) clearTimer(state.timer);
      }
      sessions.clear();
      running.clear();
      unsubscribe?.();
    },
  };
}

/** 同一成员在窗口内重复上报时只保留最后一条（否则 details 会被同一成员刷满）。 */
function pushChange(state: SessionState, change: PeerStopChange): void {
  const index = state.changes.findIndex((entry) => entry.agent_id === change.agent_id);
  if (index >= 0) state.changes.splice(index, 1);
  state.changes.push(change);
  while (state.changes.length > MAX_BUFFERED_CHANGES) state.changes.shift();
}

/** 一批变更 → 一条 notice：summary 报汇总（同错合并），details 报成员名。 */
export function buildPeerNotice(changes: readonly PeerStopChange[]): RuntimeNotice {
  const counts: Record<PeerStopKind, number> = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    closed: 0,
  };
  const labels = new Map<string, number>();
  for (const change of changes) {
    counts[change.kind] += 1;
    if (change.kind !== 'failed') continue;
    const label = errorLabel(change.error) ?? 'failed';
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }

  const parts: string[] = [];
  if (counts.completed > 0) parts.push(`${counts.completed} finished`);
  if (counts.failed > 0) {
    const inline = labelSummary(labels);
    parts.push(`${counts.failed} failed${inline === '' ? '' : ` (${inline})`}`);
  }
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  if (counts.closed > 0) parts.push(`${counts.closed} closed`);
  // 行首带 scope 词与其它 notice 同形（`config: ...` / `update ...`）：Web 的
  // `env-notice.ts` 按行首 token 认 scope，认不出就落到 `context`。
  const summary = trimTo(`peer: ${parts.join(', ')}`, NOTICE_SUMMARY_MAX);

  const { details } = peerNoticeLines(changes);

  return {
    scope: 'peer',
    summary,
    ...(details.length > 0 ? { details } : {}),
    // ok=false 表示「有成员失败」，不是「没生效」；hook 对 peer scope 不加前缀。
    ok: counts.failed === 0,
  };
}

/** 通知正文的逐行明细，以及与之严格一一对应的结构化名单（供注入事件记录）。 */
interface PeerNoticeLines {
  details: string[];
  members: { name: string; kind: string }[];
}

/**
 * 明细行与结构化名单**同源**生成，避免两处漂移：`members` 里的名字一定出现在
 * `details` 里（被 `+N more` 顶掉的那一行，两边一起丢）。
 */
function peerNoticeLines(changes: readonly PeerStopChange[]): PeerNoticeLines {
  const details: string[] = [];
  const members: { name: string; kind: string }[] = [];
  for (const change of changes) {
    if (details.length >= NOTICE_DETAILS_MAX) break;
    const who = change.name ?? change.agent_id;
    const label = change.kind === 'failed' ? errorLabel(change.error) : undefined;
    const suffix = label === undefined ? '' : ` (${label})`;
    details.push(trimTo(`${who}: ${change.kind}${suffix}`, NOTICE_SUMMARY_MAX));
    members.push({ name: trimTo(who, NOTICE_SUMMARY_MAX), kind: change.kind });
  }
  const hidden = changes.length - details.length;
  if (hidden > 0) {
    details[details.length - 1] = `+${hidden} more`;
    members.pop();
  }
  return { details, members };
}

/**
 * 同一次合并涉及的成员（名字 + 结局）：只是给 `runtime.notice.injected` 事件用的
 * 结构化副本 —— 正文里是拼好的字符串，事后 grep 事件才需要逐个名字。
 */
export function peerNoticeMembers(
  changes: readonly PeerStopChange[],
): { name: string; kind: string }[] {
  return peerNoticeLines(changes).members;
}

/** 错误 → 一行标签：优先稳定 code（`code: message` 的前缀），否则截断人话。 */
export function errorLabel(error: string | undefined): string | undefined {
  const text = (error ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  const code = /^([a-z][a-z0-9_.]{1,40}):/.exec(text);
  if (code !== null) return code[1];
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** `provider_error, timeout +2`（按出现次数降序，最多列两个）。 */
function labelSummary(labels: Map<string, number>): string {
  const sorted = [...labels.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 2).map(([label]) => label);
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
}

function sessionIdOf(event: RunEvent): string | undefined {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const sessionId = (data as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
}

function isRunTerminal(type: string): boolean {
  return type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled';
}

function trimTo(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function unref(handle: TimerHandle): void {
  (handle as { unref?: () => void }).unref?.();
}
