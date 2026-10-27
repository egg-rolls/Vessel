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
  /** 请求产生时绑定的 tenant；应答必须来自同一 tenant（P0-1） */
  tenant_id: string;
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
  /** 请求产生时绑定的 tenant；应答必须来自同一 tenant（P0-1） */
  tenant_id: string;
  ts: number;
  session_id?: string;
  parent_session_id?: string;
  /** 原始 questions；只用于 `interactions.list` 展示，不持久化。 */
  questions?: unknown;
}

/** 注册表选项。 */
export interface InteractionsRegistryOptions {
  /**
   * tenant 运行时事件流：权限 / ask 应答直接投递到这里。
   * 找不到流说明 tenant / run 已结束，应答返回 `run_ended`。
   */
  tenantEventsFor: (tenantId: string) => EventStream | undefined;
  defaultTenantId: string;
  /** 交互持久化目录；缺省 = 不落盘。 */
  interactionsDir?: string;
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
    tenantId?: string,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult;
  respondAsk(
    requestId: string,
    answers: unknown[],
    tenantId?: string,
    actor?: InteractionActor,
  ): AskRespondResult;
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
  const { tenantEventsFor, defaultTenantId } = options;

  /** 内存 pending 权限索引；真相源是 `interactionRecords`。 */
  const pendingPermissions = new Map<string, PendingPermission>();
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  const interactionRecords = new Map<string, StoredInteraction>();
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

  /** 重写某个 tenant 的全部记录；写失败只记 stderr（RPC 不因此失败）。 */
  function persistTenant(tenantId: string): void {
    if (!interactionsStore) return;
    const records = [...interactionRecords.values()]
      .filter((record) => record.tenant_id === tenantId)
      .sort((a, b) => a.created_at - b.created_at);
    void interactionsStore.save(tenantId, records);
  }

  function persistTenants(tenantIds: ReadonlySet<string>): void {
    for (const tenantId of tenantIds) persistTenant(tenantId);
  }

  /**
   * 启动时加载持久化记录。
   *
   * 本进程尚未执行任何 run，因此加载到的 `pending` 一定没有对应 run：
   * 标记为 `orphaned`，应答返回 `run_ended`，不假装可执行。
   */
  function hydrateInteractions(): void {
    if (!interactionsStore) return;
    const changedTenants = new Set<string>();
    for (const loaded of interactionsStore.loadAllSync()) {
      const record: StoredInteraction =
        loaded.status === 'pending' ? { ...loaded, status: 'orphaned' as const } : loaded;
      if (record.status !== loaded.status) changedTenants.add(record.tenant_id);
      interactionRecords.set(record.requestId, record);
    }
    persistTenants(changedTenants);
  }

  hydrateInteractions();

  /** 应答投递目标：只能是该 tenant 的运行时流（工具 / 权限策略正在等它）。 */
  function answerStreamFor(tenantId: string): EventStream {
    const stream = tenantEventsFor(tenantId);
    if (stream === undefined) {
      throw new RpcError('run_ended', `Tenant event stream is no longer available: ${tenantId}`, {
        tenant_id: tenantId,
      });
    }
    return stream;
  }

  /** 事件归属 tenant：事件自带优先，否则 default。没有 run 记录映射。 */
  function eventTenantId(event: RunEvent): string {
    if (event.tenant_id !== undefined && event.tenant_id.length > 0) return event.tenant_id;
    return defaultTenantId;
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
    rememberRecord({ ...record, status: 'answered' as const, answer });
    persistTenant(record.tenant_id);
  }

  function handleEvent(event: RunEvent): void {
    if (event.type === 'tool.permission.request') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const requestTs = eventTs(event);
        const tenantId = eventTenantId(event);
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
          tenant_id: tenantId,
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
          tenant_id: tenantId,
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
        persistTenant(tenantId);
      }
      return;
    }
    if (event.type === 'ask.user.requested') {
      const data = isRecord(event.data) ? event.data : {};
      const requestId = nonEmptyString(data.requestId);
      if (requestId !== undefined) {
        const tenantId = eventTenantId(event);
        const sessionId = nonEmptyString(data.session_id);
        const parentSessionId = nonEmptyString(data.parent_session_id);
        const agentId = nonEmptyString(data.agent_id);
        const teamId = nonEmptyString(data.team_id);
        const toolCallId = nonEmptyString(data.tool_call_id);
        rememberRecord({
          requestId,
          run_id: event.run_id,
          tenant_id: tenantId,
          kind: 'ask',
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(teamId !== undefined ? { team_id: teamId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
          ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
          ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
          tool: typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : 'ask_user',
          input: data.questions,
          created_at: eventTs(event),
          status: 'pending',
        });
        persistTenant(tenantId);
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
      const terminalTenants = new Set<string>();
      for (const [id, record] of interactionRecords) {
        if (record.status !== 'pending' || record.run_id !== event.run_id) continue;
        pendingPermissions.delete(id);
        rememberRecord({ ...record, status: 'orphaned' as StoredInteractionStatus });
        terminalTenants.add(record.tenant_id);
      }
      persistTenants(terminalTenants);
    }
  }

  function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    tenantId?: string,
    scope?: PermissionScope,
    actor?: InteractionActor,
  ): PermissionRespondResult {
    // scope 优先；remember 是旧客户端的兼容写法（等价 always）。
    const resolvedScope: PermissionScope = scope ?? (remember ? 'always' : 'once');
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const pending = pendingPermissions.get(requestId);
    if (pending !== undefined) {
      // P0-1：应答必须与请求产生时的 tenant 一致。
      if (tenantId !== undefined && pending.tenant_id !== tenantId) {
        throw new RpcError('not_found', `Permission request not found: ${requestId}`);
      }
      const record = interactionRecords.get(requestId);
      const now = Date.now();
      const latency = Math.max(0, now - (record?.created_at ?? pending.ts));
      // 先投递；流缺失抛 run_ended，pending 保持不变（迟到的流仍可重试）。
      answerStreamFor(pending.tenant_id).publish({
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
        tenant_id: pending.tenant_id,
      });
      pendingPermissions.delete(requestId);
      rememberRecord({
        ...(record ?? {
          requestId,
          run_id: pending.run_id,
          tenant_id: pending.tenant_id,
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
      persistTenant(pending.tenant_id);
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
      if (tenantId !== undefined && record.tenant_id !== tenantId) {
        throw new RpcError('not_found', `Permission request not found: ${requestId}`);
      }
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
    tenantId?: string,
    actor?: InteractionActor,
  ): AskRespondResult {
    const attribution: InteractionActor = actor ?? { answered_by: 'human' };
    const record = interactionRecords.get(requestId);
    if (record === undefined || (record.kind ?? 'permission') !== 'ask') {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    // P0-1：应答必须与请求产生时的 tenant 一致。
    if (tenantId !== undefined && record.tenant_id !== tenantId) {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    if (record.status === 'pending') {
      const now = Date.now();
      const latency = Math.max(0, now - record.created_at);
      // 直接投递到该 tenant 的运行时流（ask_user 工具在那里等待）。
      answerStreamFor(record.tenant_id).publish({
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
        tenant_id: record.tenant_id,
      });
      rememberRecord({
        ...record,
        status: 'answered',
        answer: {
          answers,
          answered_at: now,
          answered_by: attribution.answered_by,
          ...(attribution.answered_via !== undefined
            ? { answered_via: attribution.answered_via }
            : {}),
          latency_ms: latency,
        },
      });
      persistTenant(record.tenant_id);
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

  /** pending ask 只读视图：从 interactionRecords 派生，不维护第二份状态。 */
  function pendingAskView(): Map<string, PendingAsk> {
    const view = new Map<string, PendingAsk>();
    for (const [requestId, record] of interactionRecords) {
      if ((record.kind ?? 'permission') !== 'ask' || record.status !== 'pending') continue;
      view.set(requestId, {
        run_id: record.run_id,
        tenant_id: record.tenant_id,
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
  };
}

/** 导出给 web / 测试使用的状态类型别名。 */
export type { StoredInteraction, StoredInteractionStatus };
