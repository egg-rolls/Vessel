/**
 * 交互注册表（0.27）：从已删除的执行引擎中搬出的权限 / ask 职责。
 *
 * 只负责交互记录，不负责调度、run 队列或执行：
 * - pending / answered / orphaned 三态；`interactionRecords` 是唯一事实源；
 * - 按 tenant 落盘（`InteractionsStore`），启动 hydrate 时把无 run 的 pending 标 orphaned；
 * - 应答只发布到请求产生时的 tenant 流；tenant 不一致一律 `not_found`；
 * - run 终态（`run.completed|failed|cancelled`）把该 run 的 pending 转 orphaned；
 *   不再有旧 turn 生命周期事件 / 成员特判（F11 已删除）。
 *
 * @module @vessel-agent/serve/interactions-registry
 */

import type { EventStream, RunEvent } from '@vessel-agent/core';
import {
  InteractionsStore,
  type StoredInteraction,
  type StoredInteractionAnswer,
  type StoredInteractionStatus,
} from './interactions-store.js';
import { RpcError } from './rpc.js';

/** 权限应答 scope（DECISION-024 §2.1）。 */
export type PermissionScope = 'once' | 'session' | 'always';

/** 待答权限请求 */
export interface PendingPermission {
  run_id: string;
  tool: string;
  input: unknown;
  ts: number;
  /** 事件携带的 deadline_at（兼容保留）；不再作为过期依据。 */
  deadline_at?: number;
  session_id?: string;
  /** bridge 请求的父会话（事件携带时记录，additive）。 */
  parent_session_id?: string;
  tool_call_id?: string;
  source?: string;
}

/** 应答者归属；agent 不是合法值（only-human）。 */
export interface InteractionActor {
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
}

/** `permission.respond` 的结果（additive）。 */
export interface PermissionRespondResult {
  ok: true;
  decision: 'allow' | 'deny';
  scope: PermissionScope;
  /** 重复应答：沿用第一次的结果，不再发布事件。 */
  duplicate?: true;
  answered_by?: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
  latency_ms?: number;
  team_id?: string;
}

/** `ask.respond` 的结果（与权限同一套幂等语义）。 */
export interface AskRespondResult {
  ok: true;
  duplicate?: true;
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
  latency_ms?: number;
  team_id?: string;
}

/** 待答 ask 请求（legacy 只读视图，由 interactionRecords 派生）。 */
export interface PendingAsk {
  run_id: string;
  ts: number;
  session_id?: string;
  parent_session_id?: string;
  /** 原始 questions；只用于 `interactions.list` 展示，不持久化。 */
  questions?: unknown;
}

/** 注册表选项。 */
export interface InteractionsRegistryOptions {
  /**
   * 单运行时事件流：权限 / ask 应答直接投递到这里。
   * 找不到流说明 run 已结束，应答返回 `run_ended`。
   */
  eventsFor: () => EventStream | undefined;
  /** 单 id：只用于交互记录文件名（R1 路径形状不变）。 */
  singleTenantId: string;
  /** 交互持久化目录；缺省 = 不落盘。 */
  interactionsDir?: string;
  /**
   * 启动 hydrate 时如何对待磁盘上的 `pending`。
   *
   * gateway 的语义是「本进程没有对应 run」→ `orphaned`（默认）；
   * 离线 attention 只读写文件、没有 run，但请求可能属于一个 `interrupted`
   * 的 headless run，仍可被人类回答 → `pending`。
   */
  hydratePendingAs?: 'orphaned' | 'pending';
  /**
   * 0.52：async ask 拿到**第一次**答案时通知调用方（投放答案 / 起新 run）。
   *
   * **投放的唯一触发点**：RPC 应答（`respondAsk`）与流上应答
   * （`ask.user.answered`，TUI / policy）两条路共用 `settleAnswer` 这一个出口，
   * 而出口只在「记录此刻还是 pending」的那一次迁移上通知（见 `settleAnswer`）。
   * 装配层不要在同一个注册表上挂两份，也不要再加第二条触发路径（比如让
   * `ask.respond` 的 handler 自己再投一次）。同一条运行时流上并存多个 gateway
   * 装配时，重复通知由 gateway 的进程级单飞去重（`asyncAnswerDeliveries`）。
   * 实现方必须自吞全部错误（答案已经落定，投放失败只退化为「只记录答案」）。
   */
  onAsyncAskAnswered?: (record: StoredInteraction) => void;
}

/** 交互注册表（serve 内唯一交互状态）。 */
export interface InteractionsRegistry {
  /** 内存 pending 权限索引；真相源是 `interactionRecords`。 */
  readonly pendingPermissions: Map<string, PendingPermission>;
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  readonly interactionRecords: Map<string, StoredInteraction>;
  /** pending ask 的 legacy 只读视图；由 `interactionRecords` 派生。 */
  readonly pendingAsks: Map<string, PendingAsk>;
  /** 由 gateway 的 hub 原始订阅调用。 */
  handleEvent(event: RunEvent): void;
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult;
  respondAsk(requestId: string, answers: unknown[], actor?: InteractionActor): AskRespondResult;
  /**
   * 0.52：把「答案已投放」写进记录（幂等标记，`answer.delivered_at`）。
   * 返回 false = 记录不存在或还不是 answered。
   */
  markAnswerDelivered(requestId: string, deliveredAt: number): boolean;
  /**
   * 0.52：从**持久化文件**重读一条记录（只读，不改内存、不改格式）。
   *
   * 用途是「跨进程 / 跨重启兜底」：`interactionRecords` 只在启动 hydrate 时与磁盘
   * 对齐，另一个进程（或本进程重启前的自己）写下的 `answer.delivered_at` 只存在于
   * 文件里。投放前用它确认一次「这条答案是不是已经被投过了」。
   * 读失败 / 无 store 一律返回 undefined（不阻断投放）。
   */
  peekPersistedAnswer(requestId: string): StoredInteraction | undefined;
}

/** 记录上限（防止长时间进程无界增长）；淘汰只碰非 pending。 */
const MAX_RECORDS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventTs(event: RunEvent): number {
  return typeof event.ts === 'number' && Number.isFinite(event.ts) && event.ts > 0
    ? event.ts
    : Date.now();
}

/** answers 是模型 / UI 产出的任意 JSON；按结构比较，不按 key 顺序。 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

/** `answered_by` 缺省视为 human；非法值（含伪造的 agent）返回 undefined。 */
function readAnsweredBy(value: unknown): 'human' | 'policy' | undefined {
  if (value === undefined) return 'human';
  return value === 'human' || value === 'policy' ? value : undefined;
}

/** 创建交互注册表。 */
export function createInteractionsRegistry(
  options: InteractionsRegistryOptions,
): InteractionsRegistry {
  const { eventsFor, singleTenantId } = options;

  /** 内存 pending 权限索引；真相源是 `interactionRecords`。 */
  const pendingPermissions = new Map<string, PendingPermission>();
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  const interactionRecords = new Map<string, StoredInteraction>();
  /**
   * headless 因等不到人类而挂起的 ask（0.33）。
   *
   * 这类请求的 run 会以 `run.failed` 收口（checkpoint 是 `interrupted`），
   * 不能按普通终态转 `orphaned`——人类稍后仍要回答它。
   */
  const suspendedAskIds = new Set<string>();
  const interactionsStore =
    options.interactionsDir !== undefined && options.interactionsDir !== ''
      ? new InteractionsStore(options.interactionsDir)
      : undefined;

  /** 记录有界：只淘汰非 pending 的记录，绝不丢未应答请求。 */
  function rememberRecord(record: StoredInteraction): void {
    interactionRecords.set(record.requestId, record);
    if (interactionRecords.size <= MAX_RECORDS) return;
    for (const [id, item] of interactionRecords) {
      if (interactionRecords.size <= MAX_RECORDS) break;
      if (item.status !== 'pending') interactionRecords.delete(id);
    }
  }

  /**
   * 落盘串行链（0.33）。
   *
   * `save` 是 fire-and-forget；并发 atomicWrite 可能乱序落盘，
   * 让较早的快照（例如 `suspended` 之前的 ask）覆盖较新的状态。串行化后，
   * 最后一次调用的快照一定最后落盘。
   */
  let persistChain: Promise<void> = Promise.resolve();

  /** 重写交互记录文件；写失败只记 stderr（RPC 不因此失败）。 */
  function persist(): void {
    const store = interactionsStore;
    if (!store) return;
    const records = [...interactionRecords.values()].sort((a, b) => a.created_at - b.created_at);
    const next = persistChain
      .catch(() => undefined)
      .then(() => store.save(singleTenantId, records))
      .catch(() => undefined);
    persistChain = next;
  }

  /**
   * 启动时加载持久化记录。
   *
   * gateway：本进程尚未执行任何 run，加载到的 `pending` 一定没有对应 run，
   * 标记为 `orphaned`，应答返回 `run_ended`，不假装可执行。
   * 离线 attention：`hydratePendingAs: 'pending'`，让 headless run 挂起后
   * 仍可被人类回答（文件是唯一事实源）。
   */
  function hydrateInteractions(): void {
    if (!interactionsStore) return;
    const pendingStatus = options.hydratePendingAs ?? 'orphaned';
    let changed = false;
    for (const loaded of interactionsStore.loadAllSync()) {
      // 0.33：headless 挂起的 ask（suspended）即使重启后也要保持 pending，
      // 否则人类永远答不了、--resume-run 也拿不到答案。
      // 0.52：async ask 同理 —— 它的 run 早就在工具返回后正常结束了，请求仍然有效。
      const keepPending =
        loaded.status === 'pending' &&
        (pendingStatus === 'pending' ||
          (loaded.kind === 'ask' && (loaded.suspended === true || loaded.mode === 'async')));
      const record: StoredInteraction =
        loaded.status === 'pending' && !keepPending
          ? { ...loaded, status: 'orphaned' as StoredInteractionStatus }
          : loaded;
      if (record.status !== loaded.status) changed = true;
      interactionRecords.set(record.requestId, record);
    }
    if (changed) persist();
  }

  hydrateInteractions();

  /** 应答投递目标：单运行时流（工具 / 权限策略正在等它）。 */
  function answerStream(): EventStream {
    const stream = eventsFor();
    if (stream === undefined) {
      throw new RpcError('run_ended', 'Runtime event stream is no longer available');
    }
    return stream;
  }

  /**
   * 一次 `pending → answered` 迁移的唯一收口：落记录、清索引，并在这是
   * **async ask 的第一次答案**时通知调用方投放（0.52）。
   *
   * 两条应答路径（RPC 的 `respondAsk` 与流上的 `ask.user.answered`）都走这里，
   * 所以这里必须自己判定「这是不是真的那一次迁移」：
   *
   * - 流上应答：`recordStreamResponse` 进来时已经确认过 `status === 'pending'`；
   * - RPC 应答：`respondAsk` 先把 `ask.user.answered` publish 到流上，原始订阅者
   *   （hub → gateway → 本注册表）**同步**走一遍这里 —— 这一次才是真迁移；publish
   *   返回后 `respondAsk` 自己还会再 settle 一次，而它手上的 `record` 是 publish
   *   之前的快照（状态已过期）。
   *
   * 不判「此刻是否仍 pending」就会对同一次答案通知两次 → 装配层收到两个投放请求
   * （0.52 的 async 答案双投就是这么来的：单看「都进 settleAnswer」并不等于只触发
   * 一次）。返回值 = 本次是否真的是那次迁移。
   */
  function settleAnswer(record: StoredInteraction, answer: StoredInteractionAnswer): boolean {
    const current = interactionRecords.get(record.requestId);
    const first = current === undefined || current.status === 'pending';
    suspendedAskIds.delete(record.requestId);
    rememberRecord({ ...record, status: 'answered' as const, answer });
    persist();
    if (!first) return false;
    if ((record.kind ?? 'permission') === 'ask' && record.mode === 'async') {
      options.onAsyncAskAnswered?.({ ...record, status: 'answered' as const, answer });
    }
    return true;
  }

  /** 直接发布到流上的应答（TUI / policy 定时器）也要落审计；不重新发布。 */
  function recordStreamResponse(event: RunEvent): void {
    const data = isRecord(event.data) ? event.data : {};
    const requestId = nonEmptyString(data.requestId);
    if (requestId === undefined) return;
    const record = interactionRecords.get(requestId);
    if (record === undefined || record.status !== 'pending') return;
    const isAsk = event.type === 'ask.user.answered';
    if (((record.kind ?? 'permission') === 'ask') !== isAsk) return;
    const answeredBy = readAnsweredBy(data.answered_by);
    // 非法归属（含伪造的 agent）不得写进审计。
    if (answeredBy === undefined) return;
    const answers = Array.isArray(data.answers) ? data.answers : undefined;
    const decision =
      data.decision === 'allow' || data.decision === 'deny' ? data.decision : undefined;
    if (isAsk) {
      if (answers === undefined) return;
    } else if (decision === undefined) {
      return;
    }

    const answeredAt = eventTs(event);
    const rawScope = data.scope;
    const scope: PermissionScope =
      rawScope === 'once' || rawScope === 'session' || rawScope === 'always' ? rawScope : 'once';
    const answeredVia =
      data.answered_via === 'tui' ||
      data.answered_via === 'rpc' ||
      data.answered_via === 'cli' ||
      data.answered_via === 'policy'
        ? data.answered_via
        : undefined;
    const policy =
      data.policy === 'deny_after' || data.policy === 'auto_allow' ? data.policy : undefined;
    const answer: StoredInteractionAnswer = {
      answered_at: answeredAt,
      answered_by: answeredBy,
      latency_ms: Math.max(0, answeredAt - record.created_at),
      ...(answeredVia !== undefined ? { answered_via: answeredVia } : {}),
      ...(policy !== undefined ? { policy } : {}),
      ...(isAsk
        ? { answers: answers as unknown[] }
        : { decision: decision as 'allow' | 'deny', scope }),
    };
    pendingPermissions.delete(requestId);
    settleAnswer(record, answer);
  }

  function handleEvent(event: RunEvent): void {
    if (event.type === 'tool.permission.request') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const requestTs = eventTs(event);
        const tool = typeof data.tool === 'string' ? data.tool : 'tool';
        const sessionId = nonEmptyString(data.session_id);
        const toolCallId = nonEmptyString(data.tool_call_id);
        const parentSessionId = nonEmptyString(data.parent_session_id);
        const agentId = nonEmptyString(data.agent_id);
        const teamId = nonEmptyString(data.team_id);
        const deadlineAt =
          typeof data.deadline_at === 'number' &&
          Number.isFinite(data.deadline_at) &&
          data.deadline_at > 0
            ? data.deadline_at
            : undefined;
        pendingPermissions.set(requestId, {
          run_id: event.run_id,
          tool,
          input: data.input,
          ts: requestTs,
          ...(deadlineAt !== undefined ? { deadline_at: deadlineAt } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          ...(typeof data.source === 'string' && data.source.length > 0
            ? { source: data.source }
            : {}),
        });
        rememberRecord({
          requestId,
          run_id: event.run_id,
          kind: 'permission',
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(teamId !== undefined ? { team_id: teamId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          tool,
          input: data.input,
          created_at: requestTs,
          status: 'pending',
        });
        persist();
      }
      return;
    }
    if (event.type === 'ask.user.requested') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const sessionId = nonEmptyString(data.session_id);
        const parentSessionId = nonEmptyString(data.parent_session_id);
        const agentId = nonEmptyString(data.agent_id);
        const teamId = nonEmptyString(data.team_id);
        const toolCallId = nonEmptyString(data.tool_call_id);
        rememberRecord({
          requestId,
          run_id: event.run_id,
          kind: 'ask',
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(teamId !== undefined ? { team_id: teamId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          // 0.52：投递语义跟着请求走；缺省不写该键 = sync（旧事件逐字节不变）。
          ...(data.mode === 'async' ? { mode: 'async' as const } : {}),
          tool: typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : 'ask_user',
          input: data.questions,
          created_at: eventTs(event),
          status: 'pending',
        });
        persist();
      }
      return;
    }
    if (event.type === 'ask.user.timeout') {
      // headless 等不到人类：run 即将以 `interrupted` 收口。标住 requestId，
      // 下面的终态清理会保留它以等待迟到的回答；同时把 suspended 写进记录，
      // 让下一个 gateway 进程启动 hydrate 时也不把它转 orphaned。
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        suspendedAskIds.add(requestId);
        const record = interactionRecords.get(requestId);
        if (
          record !== undefined &&
          record.status === 'pending' &&
          (record.kind ?? 'permission') === 'ask' &&
          record.suspended !== true
        ) {
          rememberRecord({ ...record, suspended: true });
          persist();
        }
      }
      return;
    }
    if (event.type === 'tool.permission.response' || event.type === 'ask.user.answered') {
      recordStreamResponse(event);
      return;
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      // run 终态：该 run 的 pending（permission + ask）全部转 orphaned；
      // 迟到应答返回 run_ended，不再假装可以继续。
      for (const [id, record] of interactionRecords) {
        if (record.status !== 'pending' || record.run_id !== event.run_id) continue;
        // headless ask 的 run 以 interrupted 收口：请求仍然有效，保留 pending。
        if ((record.kind ?? 'permission') === 'ask' && suspendedAskIds.has(id)) continue;
        // 0.52：async ask 的 run 在工具返回后照常收口，请求本身还没被回答 —— 保留 pending。
        if ((record.kind ?? 'permission') === 'ask' && record.mode === 'async') continue;
        pendingPermissions.delete(id);
        rememberRecord({ ...record, status: 'orphaned' as StoredInteractionStatus });
      }
      persist();
    }
  }

  function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult {
    // scope 优先；remember 是旧客户端的兼容写法（等价 always）。
    const resolvedScope: PermissionScope = scope ?? (remember ? 'always' : 'once');
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const pending = pendingPermissions.get(requestId);
    if (pending !== undefined) {
      const record = interactionRecords.get(requestId);
      const now = Date.now();
      const latency = Math.max(0, now - (record?.created_at ?? pending.ts));
      // 先投递；流缺失抛 run_ended，pending 保持不变（迟到的流仍可重试）。
      answerStream().publish({
        type: 'tool.permission.response',
        run_id: pending.run_id,
        data: {
          requestId,
          decision,
          scope: resolvedScope,
          ...(resolvedScope === 'always' ? { remember: true } : {}),
          ...(pending.session_id !== undefined ? { session_id: pending.session_id } : {}),
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
          ...(record?.team_id !== undefined ? { team_id: record.team_id } : {}),
        },
        ts: now,
      });
      pendingPermissions.delete(requestId);
      rememberRecord({
        ...(record ?? {
          requestId,
          run_id: pending.run_id,
          kind: 'permission' as const,
          tool: pending.tool,
          input: pending.input,
          created_at: pending.ts,
        }),
        status: 'answered',
        answer: {
          decision,
          scope: resolvedScope,
          answered_at: now,
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
        },
      });
      persist();
      return {
        ok: true,
        decision,
        scope: resolvedScope,
        ...(actor !== undefined
          ? {
              answered_by: attribution.answered_by,
              ...(attribution.answered_via !== undefined
                ? { answered_via: attribution.answered_via }
                : {}),
              latency_ms: latency,
              ...(record?.team_id !== undefined ? { team_id: record.team_id } : {}),
            }
          : {}),
      };
    }

    // 幂等：首次应答生效，重复应答返回上次结果（不发布新事件）。
    const record = interactionRecords.get(requestId);
    if (record !== undefined) {
      if (record.status === 'answered' && record.answer !== undefined) {
        if (record.answer.decision !== decision) {
          throw new RpcError(
            'conflict',
            `Permission request already answered as ${record.answer.decision}: ${requestId}`,
          );
        }
        return {
          ok: true,
          decision,
          scope: record.answer.scope ?? 'once',
          duplicate: true,
          ...(actor !== undefined
            ? {
                answered_by: record.answer.answered_by ?? 'human',
                ...(record.answer.answered_via !== undefined
                  ? { answered_via: record.answer.answered_via }
                  : {}),
                ...(record.answer.latency_ms !== undefined
                  ? { latency_ms: record.answer.latency_ms }
                  : {}),
                ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
              }
            : {}),
        };
      }
      // run 已终止 / 进程重启后找不到 run：明确告知，不伪装成 not_found。
      throw new RpcError(
        'run_ended',
        `Run has ended; permission request is no longer valid: ${requestId}`,
        {
          status: record.status === 'pending' ? 'orphaned' : record.status,
          run_id: record.run_id,
          requestId,
        },
      );
    }

    throw new RpcError('not_found', `Permission request not found: ${requestId}`);
  }

  function respondAsk(
    requestId: string,
    answers: unknown[],
    actor?: InteractionActor,
  ): AskRespondResult {
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const record = interactionRecords.get(requestId);
    if (record === undefined || (record.kind ?? 'permission') !== 'ask') {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    if (record.status === 'pending') {
      const now = Date.now();
      const latency = Math.max(0, now - record.created_at);
      // 直接投递到单运行时流（ask_user 工具在那里等待）。
      //
      // 注意（0.52）：这次 publish 是**同步**扇出的 —— 原始订阅者
      // （hub → gateway → 本注册表）会立刻走 `recordStreamResponse` →
      // `settleAnswer`，也就是「流上回声」这一次才是真正的 `pending → answered`
      // 迁移。下面那次 `settleAnswer(record, …)` 用的是 publish 之前的快照，
      // 因此它被 `settleAnswer` 内部的 pending 判定挡成幂等重放（不再通知投放）。
      answerStream().publish({
        type: 'ask.user.answered',
        run_id: record.run_id,
        data: {
          requestId,
          answers,
          ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
          ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
        },
        ts: now,
      });
      // publish 之后可能已经被流上回声落定（见上）：只有记录**仍然** pending
      // 时才需要本地收口（例如装配里没有原始订阅者）。`settleAnswer` 内部还有
      // 同一道判定做硬保险，这里只是省掉一次重复落盘。
      const settled = interactionRecords.get(requestId);
      if (settled === undefined || settled.status === 'pending') {
        settleAnswer(record, {
          answers,
          answered_at: now,
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
        });
      }
      return {
        ok: true,
        answered_by: attribution.answered_by,
        ...(attribution.answered_via !== undefined
          ? { answered_via: attribution.answered_via }
          : {}),
        latency_ms: latency,
        ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
      };
    }
    if (record.status === 'answered') {
      if (record.answer !== undefined && jsonEqual(record.answer.answers ?? [], answers)) {
        return {
          ok: true,
          duplicate: true,
          answered_by: record.answer.answered_by ?? 'human',
          ...(record.answer.answered_via !== undefined
            ? { answered_via: record.answer.answered_via }
            : {}),
          ...(record.answer.latency_ms !== undefined
            ? { latency_ms: record.answer.latency_ms }
            : {}),
          ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
        };
      }
      throw new RpcError(
        'conflict',
        `Ask request already answered with different answers: ${requestId}`,
      );
    }
    throw new RpcError('run_ended', `Run has ended; ask request is no longer valid: ${requestId}`, {
      status: record.status,
      run_id: record.run_id,
      requestId,
    });
  }

  /**
   * 0.52：async 答案投放成功后写幂等标记（`answer.delivered_at`）。
   *
   * 只认已经 answered 的记录；返回 false 表示没有可标记的状态（记录不存在 /
   * 还没答 / 已被别处投放）。重复应答时调用方据此跳过第二次投放。
   */
  function markAnswerDelivered(requestId: string, deliveredAt: number): boolean {
    const record = interactionRecords.get(requestId);
    if (record === undefined || record.status !== 'answered' || record.answer === undefined) {
      return false;
    }
    if (record.answer.delivered_at !== undefined) return true;
    rememberRecord({ ...record, answer: { ...record.answer, delivered_at: deliveredAt } });
    persist();
    return true;
  }

  /**
   * 0.52：从磁盘重读一条记录（只读；见接口注释里的跨进程用途）。
   *
   * 整文件读一次而不是缓存：这条路径每次 async 答案最多走一次，换「永不陈旧」。
   * 任何读失败都当作「没有这条记录」，不阻断投放（宁可多投一次也不丢答案）。
   */
  function peekPersistedAnswer(requestId: string): StoredInteraction | undefined {
    const store = interactionsStore;
    if (store === undefined) return undefined;
    try {
      return store.loadAllSync().find((record) => record.requestId === requestId);
    } catch (error) {
      console.warn('[vessel] interactions: persisted record reload failed', {
        request_id: requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** pending ask 只读视图：从 interactionRecords 派生，不维护第二份状态。 */
  function pendingAskView(): Map<string, PendingAsk> {
    const view = new Map<string, PendingAsk>();
    for (const [requestId, record] of interactionRecords) {
      if ((record.kind ?? 'permission') !== 'ask' || record.status !== 'pending') continue;
      view.set(requestId, {
        run_id: record.run_id,
        ts: record.created_at,
        ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
        ...(record.parent_session_id !== undefined
          ? { parent_session_id: record.parent_session_id }
          : {}),
        ...(record.input !== undefined ? { questions: record.input } : {}),
      });
    }
    return view;
  }

  return {
    pendingPermissions,
    interactionRecords,
    get pendingAsks() {
      return pendingAskView();
    },
    handleEvent,
    respondPermission,
    respondAsk,
    markAnswerDelivered,
    peekPersistedAnswer,
  };
}

/** 导出给 web / 测试使用的状态类型别名。 */
export type { StoredInteraction, StoredInteractionStatus };
