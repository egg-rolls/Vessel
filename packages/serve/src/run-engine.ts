/**
 * 共享运行引擎（0.5 E10；A-5 §12.1）。
 *
 * gateway 与 `createLocalRpcDispatcher` 共用同一套 run 队列、权限请求与
 * ask 状态；禁止第二套实现。引擎不监听端口、不持有 server。
 *
 * @module @vessel-agent/serve/run-engine
 */

import { randomUUID } from 'node:crypto';
import type { ContextManager, EventStream, RunEvent, RunnableAgent } from '@vessel-agent/core';
import {
  InteractionsStore,
  type StoredInteraction,
  type StoredInteractionAnswer,
  type StoredInteractionStatus,
} from './interactions-store.js';
import type { RunStatus } from './protocol.js';
import { RpcError } from './rpc.js';

/** `run.failed` envelope 的子集；只保存可公开字段。 */
export interface RunErrorMeta {
  error_code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  http_status?: number;
  details?: Record<string, unknown>;
}

/** 网关级运行记录 */
export interface RunRecord extends RunStatus {
  input: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  /** run 归属 tenant */
  tenant_id: string;
  /** 0.15 E6：终态错误 envelope（来自 run.failed 事件）。 */
  error_meta?: RunErrorMeta;
}

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
  /**
   * 事件携带的 deadline_at（兼容保留）；Addendum A 起**不再作为过期依据**。
   */
  deadline_at?: number;
  session_id?: string;
  /** 成员 bridge 请求的父会话（事件携带时记录，additive）。 */
  parent_session_id?: string;
  tool_call_id?: string;
  source?: string;
}

/** 应答者归属；agent 不是合法值（only-human）。 */
export interface InteractionActor {
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'policy';
}

/** `permission.respond` 的结果（additive）。 */
export interface PermissionRespondResult {
  ok: true;
  decision: 'allow' | 'deny';
  scope: PermissionScope;
  /** 重复应答：沿用第一次的结果，不再发布事件。 */
  duplicate?: true;
  answered_by?: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'policy';
  latency_ms?: number;
  team_id?: string;
}

/** `ask.respond` 的结果（0.19 S4：与权限同一套幂等语义）。 */
export interface AskRespondResult {
  ok: true;
  duplicate?: true;
  answered_by: 'human' | 'policy';
  answered_via?: 'tui' | 'rpc' | 'policy';
  latency_ms?: number;
  team_id?: string;
}

/** 待答 ask 请求（legacy 只读视图，由 interactionRecords 派生） */
export interface PendingAsk {
  run_id: string;
  /** 请求产生时绑定的 tenant；应答必须来自同一 tenant（P0-1） */
  tenant_id: string;
  ts: number;
  /** 关联 session（`ask.user.requested` 事件携带时记录，additive）。 */
  session_id?: string;
  /** 成员 bridge 请求的父会话（事件携带时记录，additive）。 */
  parent_session_id?: string;
  /** 原始 questions；只用于 `interactions.list` 展示，不持久化。 */
  questions?: unknown;
}

/** 引擎选项 */
export interface RunEngineOptions {
  runtime?: RunnableAgent;
  context?: ContextManager;
  runtimeFor?: (tenantId: string) => RunnableAgent | undefined;
  contextFor?: (tenantId: string) => ContextManager | undefined;
  /**
   * tenant 运行时事件流（0.18，必填）：权限 / ask 应答直接投递到这里。
   * 引擎不持有任何共享 / 单流 `events`；找不到流说明 tenant / run 已结束。
   */
  tenantEventsFor: (tenantId: string) => EventStream | undefined;
  defaultTenantId: string;
  maxQueue?: number;
  maxRuns?: number;
  /**
   * 权限交互持久化目录；缺省 = 不落盘。
   * 由 gateway 注入 `<dataDir>`（Addendum A §2）。
   */
  interactionsDir?: string;
}

/** 共享运行引擎 */
export interface RunEngine {
  readonly runs: Map<string, RunRecord>;
  readonly queue: RunRecord[];
  readonly coreToJob: Map<string, string>;
  readonly pendingPermissions: Map<string, PendingPermission>;
  /** pending ask 的 legacy 只读视图；真相源是 `interactionRecords`。 */
  readonly pendingAsks: Map<string, PendingAsk>;
  /** requestId → 持久化交互记录（pending / answered / orphaned）。 */
  readonly interactionRecords: Map<string, StoredInteraction>;
  /** durable resume 在途占位 */
  readonly resumedRuns: Set<string>;
  readonly active: RunRecord | null;
  activeSessionId: string;
  /** 由 gateway 的 EventStream 订阅或本地 dispatcher 的订阅调用 */
  handleEvent(event: RunEvent): void;
  submitRun(
    params: Record<string, unknown>,
    tenantId?: string,
  ): { run_id: string; status: RunStatus['status']; queue_position?: number };
  cancelRun(id: string, tenantId?: string): boolean;
  publicStatus(record: RunRecord): RunStatus;
  list(tenantId: string, options?: { sessionId?: string; status?: string }): RunStatus[];
  get(id: string): RunRecord | undefined;
  /** 已受理（queued/running）的 run 数，quota 同步检查用 */
  activeCount(tenantId: string): number;
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
  reserveResume(runId: string): boolean;
  releaseResume(runId: string): void;
}

function makeDone(): { done: Promise<void>; resolveDone: () => void } {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { done, resolveDone };
}

/** 创建共享运行引擎 */
/** 从 run.failed data 中取 envelope；缺失/非法值不推断。 */
export function errorMetaOf(data: unknown): RunErrorMeta | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const source = data as Record<string, unknown>;
  const meta: RunErrorMeta = {};
  if (typeof source.error_code === 'string' && source.error_code.length > 0) {
    meta.error_code = source.error_code;
  }
  if (typeof source.category === 'string' && source.category.length > 0) {
    meta.category = source.category;
  }
  if (typeof source.phase === 'string' && source.phase.length > 0) {
    meta.phase = source.phase;
  }
  if (typeof source.retryable === 'boolean') meta.retryable = source.retryable;
  if (typeof source.http_status === 'number' && Number.isFinite(source.http_status)) {
    meta.http_status = source.http_status;
  }
  if (
    typeof source.details === 'object' &&
    source.details !== null &&
    !Array.isArray(source.details)
  ) {
    meta.details = source.details as Record<string, unknown>;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

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

function readAnsweredBy(value: unknown): 'human' | 'policy' | undefined {
  if (value === undefined) return 'human';
  return value === 'human' || value === 'policy' ? value : undefined;
}

export function createRunEngine(options: RunEngineOptions): RunEngine {
  const {
    runtime,
    context,
    runtimeFor: runtimeForOption,
    contextFor: contextForOption,
    tenantEventsFor,
    defaultTenantId,
  } = options;
  const maxQueue = options.maxQueue ?? 100;
  const maxRuns = options.maxRuns ?? 200;
  /** 记录上限（防止长时间进程无界增长）；淘汰优先 answered/orphaned。 */
  const MAX_RECORDS = 2000;

  const runs = new Map<string, RunRecord>();
  const queue: RunRecord[] = [];
  const coreToJob = new Map<string, string>();
  const pendingPermissions = new Map<string, PendingPermission>();
  /** requestId → 持久化交互记录（唯一事实源，pending 表只是索引）。 */
  const interactionRecords = new Map<string, StoredInteraction>();
  const interactionsStore =
    options.interactionsDir !== undefined && options.interactionsDir !== ''
      ? new InteractionsStore(options.interactionsDir)
      : undefined;
  const activeByTenant = new Map<string, number>();
  const resumedRuns = new Set<string>();

  let active: RunRecord | null = null;
  let activeSessionId = 'default';

  function runtimeFor(tenantId: string): RunnableAgent | undefined {
    if (tenantId === defaultTenantId) return runtime;
    return runtimeForOption?.(tenantId);
  }

  function contextFor(tenantId: string): ContextManager | undefined {
    if (tenantId === defaultTenantId) return context;
    return contextForOption?.(tenantId);
  }

  function releaseTenantSlot(tenantId: string): void {
    const current = activeByTenant.get(tenantId) ?? 0;
    if (current <= 1) activeByTenant.delete(tenantId);
    else activeByTenant.set(tenantId, current - 1);
  }

  function createRun(input: string, sessionId: string, tenantId: string): RunRecord {
    const { done, resolveDone } = makeDone();
    const record: RunRecord = {
      run_id: randomUUID(),
      session_id: sessionId,
      input,
      status: 'queued',
      controller: new AbortController(),
      done,
      resolveDone,
      tenant_id: tenantId,
    };
    runs.set(record.run_id, record);
    queue.push(record);
    return record;
  }

  function queuePosition(record: RunRecord): number | undefined {
    if (record.status !== 'queued') return undefined;
    const index = queue.indexOf(record);
    return index >= 0 ? index + 1 : undefined;
  }

  function publicStatus(record: RunRecord): RunStatus {
    return {
      run_id: record.run_id,
      ...(record.core_run_id ? { core_run_id: record.core_run_id } : {}),
      session_id: record.session_id,
      status: record.status,
      ...(record.output !== undefined ? { output: record.output } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.usage ? { usage: record.usage } : {}),
      ...(record.started_at !== undefined ? { started_at: record.started_at } : {}),
      ...(record.completed_at !== undefined ? { completed_at: record.completed_at } : {}),
      ...(queuePosition(record) !== undefined ? { queue_position: queuePosition(record) } : {}),
      ...(record.error_meta ?? {}),
    };
  }

  async function execute(record: RunRecord): Promise<void> {
    record.status = 'running';
    record.started_at = Date.now();
    active = record;

    const tenantRuntime = runtimeFor(record.tenant_id);
    const tenantContext = contextFor(record.tenant_id);

    if (tenantContext && tenantContext.getSessionId() !== record.session_id) {
      tenantContext.setSessionId(record.session_id);
      tenantContext.clear();
    }

    try {
      if (!tenantRuntime) throw new Error('No runtime configured');
      const output = await tenantRuntime.run(record.input, record.session_id, {
        signal: record.controller.signal,
      });
      record.output = output;
      record.status = record.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.status = record.controller.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      record.completed_at = Date.now();
      active = null;
      record.resolveDone();
      releaseTenantSlot(record.tenant_id);
      // run 终态：映射不再被 eventTenantId 需要。
      forgetCoreRun(record.core_run_id);
      trimRuns();
      pump();
    }
  }

  function pump(): void {
    if (active || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    void execute(next);
  }

  /** 终态/trim 后不再需要 core run → gateway job 的映射。 */
  function forgetCoreRun(coreRunId: string | undefined): void {
    if (coreRunId !== undefined) coreToJob.delete(coreRunId);
  }

  function trimRuns(): void {
    if (runs.size <= maxRuns) return;
    for (const [id, record] of runs) {
      if (runs.size <= maxRuns) break;
      if (record.status !== 'running' && record.status !== 'queued') {
        forgetCoreRun(record.core_run_id);
        runs.delete(id);
      }
    }
  }

  function submitRun(
    params: Record<string, unknown>,
    tenantId: string = defaultTenantId,
  ): { run_id: string; status: RunStatus['status']; queue_position?: number } {
    if (!runtimeFor(tenantId)) {
      throw new RpcError('forbidden', 'No runtime configured', { legacy_code: 'no_runtime' });
    }
    const input = params.input;
    if (typeof input !== 'string' || input.length === 0) {
      throw new RpcError('invalid_params', 'input is required', { legacy_code: 'invalid_request' });
    }
    if (queue.length + (active ? 1 : 0) >= maxQueue) {
      throw new RpcError('conflict', 'Run queue is full', { legacy_code: 'busy' });
    }
    const requestedSession = params.session_id;
    const sessionId =
      typeof requestedSession === 'string' && requestedSession.length > 0
        ? requestedSession
        : activeSessionId;
    activeSessionId = sessionId;
    activeByTenant.set(tenantId, (activeByTenant.get(tenantId) ?? 0) + 1);
    try {
      const record = createRun(input, sessionId, tenantId);
      pump();
      return {
        run_id: record.run_id,
        status: record.status,
        ...(queuePosition(record) !== undefined ? { queue_position: queuePosition(record) } : {}),
      };
    } catch (error) {
      releaseTenantSlot(tenantId);
      throw error;
    }
  }

  function cancelRun(id: string, tenantId?: string): boolean {
    const record = runs.get(id);
    if (!record || (tenantId !== undefined && record.tenant_id !== tenantId)) {
      throw new RpcError('not_found', `Run not found: ${id}`);
    }
    if (record.status === 'queued') {
      const index = queue.indexOf(record);
      if (index >= 0) queue.splice(index, 1);
      record.status = 'cancelled';
      record.completed_at = Date.now();
      record.resolveDone();
      releaseTenantSlot(record.tenant_id);
      return true;
    }
    if (record.status === 'running') {
      record.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * 事件归属 tenant：优先 run 记录（经 coreToJob 映射），
   * 其次事件自带的 tenant_id，最后回退 default（P0-1）。
   */
  /**
   * 应答投递目标（0.18）：只能是该 tenant 的运行时流（工具 / 权限策略正在等它）。
   * 流不存在说明 tenant / run 已结束，明确拒绝而不是丢弃应答。
   */
  function answerStreamFor(tenantId: string): EventStream {
    const stream = tenantEventsFor(tenantId);
    if (stream === undefined) {
      throw new RpcError('run_ended', `Tenant event stream is no longer available: ${tenantId}`, {
        tenant_id: tenantId,
      });
    }
    return stream;
  }

  function eventTenantId(event: RunEvent): string {
    const jobId = coreToJob.get(event.run_id);
    const record = jobId === undefined ? undefined : runs.get(jobId);
    if (record !== undefined) return record.tenant_id;
    if (event.tenant_id !== undefined && event.tenant_id.length > 0) return event.tenant_id;
    return defaultTenantId;
  }

  /** 记录有界：先淘汰最旧的 answered/orphaned，绝不淘汰 pending。 */
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
   * 启动时加载持久化记录（Addendum A §2）。
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
      data.answered_via === 'tui' || data.answered_via === 'rpc' || data.answered_via === 'policy'
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

  /** 成员 turn / close 终态：按 agent_id + session_id 清理；不按 run_id（F11）。 */
  function orphanPendingForMember(agentId: string, sessionId: string): void {
    const tenants = new Set<string>();
    for (const [id, record] of interactionRecords) {
      if (record.status !== 'pending') continue;
      if (record.agent_id !== agentId || record.session_id !== sessionId) continue;
      pendingPermissions.delete(id);
      rememberRecord({ ...record, status: 'orphaned' as StoredInteractionStatus });
      tenants.add(record.tenant_id);
    }
    persistTenants(tenants);
  }

  function handleEvent(event: RunEvent): void {
    if (event.type === 'run.started' && active && !active.core_run_id) {
      active.core_run_id = event.run_id;
      coreToJob.set(event.run_id, active.run_id);
    }
    if (event.type === 'tool.permission.request') {
      const data = event.data as Record<string, unknown>;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId) {
        const requestTs = eventTs(event);
        const tenantId = eventTenantId(event);
        const tool = typeof data.tool === 'string' ? data.tool : 'tool';
        const sessionId =
          typeof data.session_id === 'string' && data.session_id.length > 0
            ? data.session_id
            : undefined;
        const toolCallId =
          typeof data.tool_call_id === 'string' && data.tool_call_id.length > 0
            ? data.tool_call_id
            : undefined;
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
    }
    if (event.type === 'tool.permission.response' || event.type === 'ask.user.answered') {
      recordStreamResponse(event);
    }
    if (
      event.type === 'agent.turn.completed' ||
      event.type === 'agent.turn.failed' ||
      event.type === 'agent.turn.cancelled' ||
      event.type === 'agent.closed'
    ) {
      const data = isRecord(event.data) ? event.data : {};
      const agentId = nonEmptyString(data.agent_id);
      const sessionId = nonEmptyString(data.session_id);
      if (agentId !== undefined && sessionId !== undefined) {
        orphanPendingForMember(agentId, sessionId);
      }
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      if (active && (active.core_run_id === event.run_id || active.run_id === event.run_id)) {
        const data = event.data as Record<string, unknown>;
        if (data.usage && typeof data.usage === 'object') {
          active.usage = data.usage as RunStatus['usage'];
        }
        if (event.type === 'run.failed') {
          const meta = errorMetaOf(data);
          if (meta) active.error_meta = meta;
        }
      }
      // run 终态：pending（permission + ask）全部转 orphaned；
      // 迟到应答返回 run_ended，不再假装可以继续（Addendum A §2）。
      const terminalTenants = new Set<string>();
      for (const [id, record] of interactionRecords) {
        if (record.status !== 'pending' || record.run_id !== event.run_id) continue;
        pendingPermissions.delete(id);
        rememberRecord({ ...record, status: 'orphaned' as StoredInteractionStatus });
        terminalTenants.add(record.tenant_id);
      }
      persistTenants(terminalTenants);
    }
    // 注意：终态事件本身仍要带 job_id 出站（gateway 在 handleEvent 之后构造帧），
    // 所以映射在 execute 的 finally（run 真正收尾）与 trimRuns 里清理。
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
    if (pending) {
      // P0-1：应答必须与请求产生时的 tenant 一致；不查 runs（run 可能已被 trim）。
      if (tenantId !== undefined && pending.tenant_id !== tenantId) {
        throw new RpcError('not_found', `Permission request not found: ${requestId}`);
      }
      const record = interactionRecords.get(requestId);
      const now = Date.now();
      const latency = Math.max(0, now - (record?.created_at ?? pending.ts));
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
    if (record) {
      if (tenantId !== undefined && record.tenant_id !== tenantId) {
        throw new RpcError('not_found', `Permission request not found: ${requestId}`);
      }
      if (record.status === 'answered' && record.answer) {
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
    // P0-1：应答必须与请求产生时的 tenant 一致；不查 runs（run 可能已被 trim）。
    if (tenantId !== undefined && record.tenant_id !== tenantId) {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    if (record.status === 'pending') {
      const now = Date.now();
      const latency = Math.max(0, now - record.created_at);
      // 0.18：直接投递到该 tenant 的运行时流（ask_user 工具在那里等待）。
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

  /** 在途占位；同一 id 并发只允许一个通过 */
  function reserveInto(set: Set<string>, id: string): boolean {
    if (set.has(id)) return false;
    set.add(id);
    while (set.size > 1000) {
      const first = set.keys().next();
      if (first.done || first.value === id) break;
      set.delete(first.value);
    }
    return true;
  }

  function reserveResume(runId: string): boolean {
    return reserveInto(resumedRuns, runId);
  }

  function releaseResume(runId: string): void {
    resumedRuns.delete(runId);
  }

  function list(tenantId: string, opts: { sessionId?: string; status?: string } = {}): RunStatus[] {
    return [...runs.values()]
      .filter((record) => record.tenant_id === tenantId)
      .filter((record) => !opts.sessionId || record.session_id === opts.sessionId)
      .filter((record) => !opts.status || record.status === opts.status)
      .map(publicStatus);
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
    runs,
    queue,
    coreToJob,
    pendingPermissions,
    get pendingAsks() {
      return pendingAskView();
    },
    interactionRecords,
    resumedRuns,
    get active() {
      return active;
    },
    get activeSessionId() {
      return activeSessionId;
    },
    set activeSessionId(value: string) {
      activeSessionId = value;
    },
    handleEvent,
    submitRun,
    cancelRun,
    publicStatus,
    list,
    get: (id) => runs.get(id),
    activeCount: (tenantId) => activeByTenant.get(tenantId) ?? 0,
    respondPermission,
    respondAsk,
    reserveResume,
    releaseResume,
  };
}
