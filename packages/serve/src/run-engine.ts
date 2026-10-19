/**
 * 共享运行引擎（0.5 E10；A-5 §12.1）。
 *
 * gateway 与 `createLocalRpcDispatcher` 共用同一套 run 队列、权限请求与
 * ask 状态；禁止第二套实现。引擎不监听端口、不持有 server。
 *
 * @module @vessel/serve/run-engine
 */

import { randomUUID } from 'node:crypto';
import type { ContextManager, EventStream, RunEvent, RunnableAgent } from '@vessel/core';
import type { RunStatus } from './protocol.js';
import { RpcError } from './rpc.js';

/** 网关级运行记录 */
export interface RunRecord extends RunStatus {
  input: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  /** run 归属 tenant */
  tenant_id: string;
}

/** 待答权限请求 */
export interface PendingPermission {
  run_id: string;
  /** 请求产生时绑定的 tenant；应答必须来自同一 tenant（P0-1） */
  tenant_id: string;
  tool: string;
  input: unknown;
  ts: number;
}

/** 待答 ask 请求 */
export interface PendingAsk {
  run_id: string;
  /** 请求产生时绑定的 tenant；应答必须来自同一 tenant（P0-1） */
  tenant_id: string;
  ts: number;
}

/** 引擎选项 */
export interface RunEngineOptions {
  events: EventStream;
  runtime?: RunnableAgent;
  context?: ContextManager;
  runtimeFor?: (tenantId: string) => RunnableAgent | undefined;
  contextFor?: (tenantId: string) => ContextManager | undefined;
  defaultTenantId: string;
  maxQueue?: number;
  maxRuns?: number;
  /** 缺省 120s，与 core 的 ask/权限超时对齐 */
  interactionTtlMs?: number;
}

/** 共享运行引擎 */
export interface RunEngine {
  readonly runs: Map<string, RunRecord>;
  readonly queue: RunRecord[];
  readonly coreToJob: Map<string, string>;
  readonly pendingPermissions: Map<string, PendingPermission>;
  readonly pendingAsks: Map<string, PendingAsk>;
  /** durable resume / workflow resume 在途占位 */
  readonly resumedRuns: Set<string>;
  readonly resumedWorkflows: Set<string>;
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
  ): void;
  respondAsk(requestId: string, answers: unknown[], tenantId?: string): void;
  reserveResume(runId: string): boolean;
  releaseResume(runId: string): void;
  reserveWorkflowResume(runId: string): boolean;
  releaseWorkflowResume(runId: string): void;
  /** 清理过期交互请求 */
  sweep(now?: number): void;
}

function makeDone(): { done: Promise<void>; resolveDone: () => void } {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { done, resolveDone };
}

/** 创建共享运行引擎 */
export function createRunEngine(options: RunEngineOptions): RunEngine {
  const {
    events,
    runtime,
    context,
    runtimeFor: runtimeForOption,
    contextFor: contextForOption,
    defaultTenantId,
  } = options;
  const maxQueue = options.maxQueue ?? 100;
  const maxRuns = options.maxRuns ?? 200;
  const interactionTtlMs = options.interactionTtlMs ?? 120_000;

  const runs = new Map<string, RunRecord>();
  const queue: RunRecord[] = [];
  const coreToJob = new Map<string, string>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const pendingAsks = new Map<string, PendingAsk>();
  const activeByTenant = new Map<string, number>();
  const resumedRuns = new Set<string>();
  const resumedWorkflows = new Set<string>();

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
  function eventTenantId(event: RunEvent): string {
    const jobId = coreToJob.get(event.run_id);
    const record = jobId === undefined ? undefined : runs.get(jobId);
    if (record !== undefined) return record.tenant_id;
    if (event.tenant_id !== undefined && event.tenant_id.length > 0) return event.tenant_id;
    return defaultTenantId;
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
        pendingPermissions.set(requestId, {
          run_id: event.run_id,
          tenant_id: eventTenantId(event),
          tool: typeof data.tool === 'string' ? data.tool : 'tool',
          input: data.input,
          ts: Date.now(),
        });
      }
    }
    if (event.type === 'ask.user.requested') {
      const data = event.data as Record<string, unknown>;
      const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
      if (requestId) {
        pendingAsks.set(requestId, {
          run_id: event.run_id,
          tenant_id: eventTenantId(event),
          ts: Date.now(),
        });
      }
    }
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      if (active && active.core_run_id === event.run_id) {
        const data = event.data as Record<string, unknown>;
        if (data.usage && typeof data.usage === 'object') {
          active.usage = data.usage as RunStatus['usage'];
        }
      }
      for (const [id, pending] of pendingAsks) {
        if (pending.run_id === event.run_id) pendingAsks.delete(id);
      }
    }
    // 注意：终态事件本身仍要带 job_id 出站（gateway 在 handleEvent 之后构造帧），
    // 所以映射在 execute 的 finally（run 真正收尾）与 trimRuns 里清理。
  }

  function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    tenantId?: string,
  ): void {
    const pending = pendingPermissions.get(requestId);
    if (!pending) {
      throw new RpcError('not_found', `Permission request not found: ${requestId}`);
    }
    // P0-1：应答必须与请求产生时的 tenant 一致；不查 runs（run 可能已被 trim）。
    if (tenantId !== undefined && pending.tenant_id !== tenantId) {
      throw new RpcError('not_found', `Permission request not found: ${requestId}`);
    }
    events.publish({
      type: 'tool.permission.response',
      run_id: pending.run_id,
      data: { requestId, decision, ...(remember ? { remember: true } : {}) },
      ts: Date.now(),
    });
    pendingPermissions.delete(requestId);
  }

  function respondAsk(requestId: string, answers: unknown[], tenantId?: string): void {
    const pending = pendingAsks.get(requestId);
    if (!pending) throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    // P0-1：应答必须与请求产生时的 tenant 一致；不查 runs（run 可能已被 trim）。
    if (tenantId !== undefined && pending.tenant_id !== tenantId) {
      throw new RpcError('not_found', `Ask request not found: ${requestId}`);
    }
    events.publish({
      type: 'ask.user.answered',
      run_id: pending.run_id,
      data: { requestId, answers },
      ts: Date.now(),
    });
    pendingAsks.delete(requestId);
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

  function reserveWorkflowResume(runId: string): boolean {
    return reserveInto(resumedWorkflows, runId);
  }

  function releaseWorkflowResume(runId: string): void {
    resumedWorkflows.delete(runId);
  }

  function sweep(now = Date.now()): void {
    for (const [id, pending] of pendingPermissions) {
      if (now - pending.ts > interactionTtlMs) pendingPermissions.delete(id);
    }
    for (const [id, pending] of pendingAsks) {
      if (now - pending.ts > interactionTtlMs) pendingAsks.delete(id);
    }
  }

  function list(tenantId: string, opts: { sessionId?: string; status?: string } = {}): RunStatus[] {
    return [...runs.values()]
      .filter((record) => record.tenant_id === tenantId)
      .filter((record) => !opts.sessionId || record.session_id === opts.sessionId)
      .filter((record) => !opts.status || record.status === opts.status)
      .map(publicStatus);
  }

  return {
    runs,
    queue,
    coreToJob,
    pendingPermissions,
    pendingAsks,
    resumedRuns,
    resumedWorkflows,
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
    reserveWorkflowResume,
    releaseWorkflowResume,
    sweep,
  };
}
