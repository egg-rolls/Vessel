/**
 * runs.* 方法（list / get / start / cancel / resume）。
 *
 * 0.27 统一 run 口径：
 * - live 只读 `RunControlLike.snapshot()`（queued + running）；serve 不再持有
 *   执行队列、runtime 入口或 run 记录；
 * - durable 读 `DurableGatewayOptions.store`（每 body checkpoint）；
 * - `runs.list` = live ∪ durable，按 `run_id` 去重、live 优先；
 * - `runs.start` / `runs.cancel` 只调控制面，执行生命周期归 app / AgentService。
 *
 * @module @vessel-agent/serve
 */

import {
  type DurableCheckpointLike,
  type DurableGatewayOptions,
  errorMetaOf,
  isResumableStatus,
  previewOf,
} from '../../durable.js';
import { RpcError, type RpcMethodContext, type RpcMethodDefinition } from '../../rpc.js';
import type { LiveRunSnapshotLike, RunControlLike } from '../../run-control.js';
import { mapTenantError, type TenantControlLike } from '../../tenant.js';
import { checkpointBelongsToTenant, stringParam } from './common.js';
import { runStatusSchema } from './schemas.js';

export interface RunMethodsDeps {
  defaultTenantId: string;
  /**
   * per-tenant run 控制面；default 用 `runControl`，其它 tenant 只走
   * `runControlFor`（缺失不回退 default）。
   */
  runControlFor(tenantId: string): RunControlLike | undefined;
  /** 同 `runControlFor`，但缺失时按 `requireRuntime` 语义抛错。 */
  requireRunControl(tenantId: string): RunControlLike;
  durableForTenant(tenantId: string): DurableGatewayOptions | undefined;
  tenants?: TenantControlLike;
  /** 已受理（queued + running）的 run 数，quota 同步检查用。 */
  activeCount(tenantId: string): number;
  reserveResume(runId: string): boolean;
  releaseResume(runId: string): void;
}

/**
 * durable checkpoint 的 additive 归一：
 * - `started_at` 缺失时用 `created_at`；
 * - 0.18：`preview` 缺失时按 `metadata.preview` / legacy messages 派生；
 * - envelope 可能在顶层或 `metadata.error_meta|error_envelope|envelope`。
 */
export function normalizeDurableRun(run: Record<string, unknown>): Record<string, unknown> {
  const out = { ...run };
  if (out.started_at === undefined && typeof out.created_at === 'number') {
    out.started_at = out.created_at;
  }
  if (out.preview === undefined) {
    const preview = previewOf(out as unknown as DurableCheckpointLike);
    if (preview !== undefined) out.preview = preview;
  }
  if (out.error_code !== undefined) return out;
  const metadata = out.metadata;
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    for (const key of ['error_meta', 'error_envelope', 'envelope']) {
      const meta = errorMetaOf(record[key]);
      if (meta) return { ...out, ...meta };
    }
  }
  return out;
}

/** live run → `runStatusSchema` 形状（不含 core_run_id：0.27 起统一 run id）。 */
export function liveRunStatus(run: LiveRunSnapshotLike): Record<string, unknown> {
  return {
    run_id: run.run_id,
    agent_id: run.agent_id,
    session_id: run.session_id,
    status: run.status,
    ...(run.queue_position !== undefined ? { queue_position: run.queue_position } : {}),
    ...(run.started_at !== undefined ? { started_at: run.started_at } : {}),
  };
}

/** snapshot 的 live run（queued 在前，running 在后）。 */
function liveRunsOf(control: RunControlLike): LiveRunSnapshotLike[] {
  try {
    const snapshot = control.snapshot();
    return [...snapshot.queued, ...snapshot.running];
  } catch {
    // 控制面不可用不得让只读列表 500；按「无 live」处理。
    return [];
  }
}

/** 排序键：`updated_at ?? started_at ?? 0`，倒序。 */
function recencyOf(run: Record<string, unknown>): number {
  const updated = run.updated_at;
  if (typeof updated === 'number' && Number.isFinite(updated)) return updated;
  const started = run.started_at;
  if (typeof started === 'number' && Number.isFinite(started)) return started;
  return 0;
}

export function createRunMethods(deps: RunMethodsDeps): RpcMethodDefinition[] {
  const {
    defaultTenantId,
    runControlFor,
    requireRunControl,
    durableForTenant,
    tenants,
    activeCount,
    reserveResume,
    releaseResume,
  } = deps;

  async function checkQuota(
    tenantId: string,
    operation: 'runs.start' | 'sessions.create',
  ): Promise<void> {
    try {
      await tenants?.checkQuota?.(tenantId, operation);
    } catch (error) {
      mapTenantError(error);
    }
  }

  async function enforceConcurrentQuota(tenantId: string): Promise<void> {
    let limit: number | undefined;
    try {
      limit = (await tenants?.get(tenantId))?.quota?.max_concurrent_runs;
    } catch (error) {
      mapTenantError(error);
    }
    if (limit !== undefined && activeCount(tenantId) >= limit) {
      throw new RpcError('quota_exceeded', `max_concurrent_runs exceeded for tenant ${tenantId}`, {
        tenant_id: tenantId,
        limit,
      });
    }
  }

  /** live 命中（该 tenant 的 snapshot 里同 id 的 queued / running）。 */
  function findLive(tenantId: string, runId: string): LiveRunSnapshotLike | undefined {
    const control = runControlFor(tenantId);
    if (control === undefined) return undefined;
    return liveRunsOf(control).find((run) => run.run_id === runId);
  }

  /**
   * `runs.list` = live ∪ durable：
   * 按 `run_id` 去重、live 优先；`updated_at ?? started_at ?? 0` 倒序。
   * `agent_id` / `session_id` / `status` 过滤可组合。
   */
  async function listRuns(
    ctx: RpcMethodContext,
    filters: { sessionId?: string; status?: string; agentId?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const control = runControlFor(ctx.tenantId);
    const durable = durableForTenant(ctx.tenantId);
    if (control === undefined && durable === undefined) {
      // 旧语义：非 default tenant 无任何运行面 → forbidden；default 返回空。
      if (ctx.tenantId !== defaultTenantId) {
        throw new RpcError(
          'forbidden',
          `Durable runs are not configured for tenant: ${ctx.tenantId}`,
        );
      }
      return [];
    }

    const live = control === undefined ? [] : liveRunsOf(control).map(liveRunStatus);
    const checkpoints =
      durable === undefined
        ? []
        : (await durable.store.list()).map((checkpoint) =>
            normalizeDurableRun(checkpoint as unknown as Record<string, unknown>),
          );

    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const run of [...live, ...checkpoints]) {
      const runId = run.run_id;
      if (typeof runId !== 'string' || seen.has(runId)) continue;
      seen.add(runId);
      merged.push(run);
    }

    return merged
      .filter(
        (run) =>
          (!filters.sessionId || run.session_id === filters.sessionId) &&
          (!filters.status || run.status === filters.status) &&
          (!filters.agentId || run.agent_id === filters.agentId),
      )
      .sort((left, right) => recencyOf(right) - recencyOf(left));
  }

  return [
    {
      name: 'runs.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string' },
          agent_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['runs'],
        properties: {
          runs: { type: 'array', items: runStatusSchema },
        },
      },
      handler: (params, ctx) =>
        listRuns(ctx, {
          ...(typeof params.session_id === 'string' ? { sessionId: params.session_id } : {}),
          ...(typeof params.status === 'string' ? { status: params.status } : {}),
          ...(typeof params.agent_id === 'string' ? { agentId: params.agent_id } : {}),
        }).then((runs) => ({ runs })),
    },
    {
      name: 'runs.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['run'],
        properties: { run: runStatusSchema },
      },
      handler: async (params, ctx) => {
        const runId = stringParam(params, 'run_id');
        const live = findLive(ctx.tenantId, runId);
        if (live !== undefined) return { run: liveRunStatus(live) };
        const durable = durableForTenant(ctx.tenantId);
        if (!durable) {
          if (ctx.tenantId !== defaultTenantId) {
            throw new RpcError(
              'forbidden',
              `Durable runs are not configured for tenant: ${ctx.tenantId}`,
            );
          }
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        // durable 页签覆盖所有 body；tenant 校验在下一行统一做。
        const checkpoint = await durable.store.load(runId);
        if (!checkpoint || !checkpointBelongsToTenant(checkpoint, ctx.tenantId)) {
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        return { run: normalizeDurableRun(checkpoint as unknown as Record<string, unknown>) };
      },
    },
    {
      name: 'runs.start',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { type: 'string', minLength: 1 },
          session_id: { type: 'string' },
          agent_id: { type: 'string', minLength: 1 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['run_id', 'status'],
        properties: {
          run_id: { type: 'string' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
          },
          queue_position: { type: 'integer' },
          agent_id: { type: 'string' },
          session_id: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        const control = requireRunControl(ctx.tenantId);
        await enforceConcurrentQuota(ctx.tenantId);
        await checkQuota(ctx.tenantId, 'runs.start');
        const agentId = typeof params.agent_id === 'string' ? params.agent_id : undefined;
        const requestedSession =
          typeof params.session_id === 'string' ? params.session_id : undefined;
        const result = await control.start({
          input: stringParam(params, 'input'),
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(requestedSession !== undefined ? { session_id: requestedSession } : {}),
        });
        // `session_id` 只能来自控制面；控制面没回传时不编造（用请求值）。
        const returnedSession = (result as { session_id?: unknown }).session_id;
        const sessionId =
          typeof returnedSession === 'string' && returnedSession.length > 0
            ? returnedSession
            : requestedSession;
        return {
          run_id: result.run_id,
          status: result.status,
          ...(result.queue_position !== undefined ? { queue_position: result.queue_position } : {}),
          ...(agentId !== undefined ? { agent_id: agentId } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        };
      },
    },
    {
      name: 'runs.cancel',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['cancelled'],
        properties: { cancelled: { type: 'boolean' } },
      },
      handler: async (params, ctx) => {
        const runId = stringParam(params, 'run_id');
        const control = runControlFor(ctx.tenantId);
        if (control === undefined) {
          if (ctx.tenantId !== defaultTenantId) {
            throw new RpcError(
              'forbidden',
              `Tenant run control is not configured: ${ctx.tenantId}`,
            );
          }
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        // 先按 snapshot 判存在（跨 tenant 一律 not_found，不泄漏存在性）。
        const target = liveRunsOf(control).find((run) => run.run_id === runId);
        if (target === undefined) throw new RpcError('not_found', `Run not found: ${runId}`);
        const cancelled = await control.cancel(runId);
        // scheduler 不会为 queued-cancel 产出 core 事件，也就没有 checkpoint；
        // 补一条终态 checkpoint，否则该 run 会从列表消失。
        if (target.status === 'queued') {
          await writeQueuedCancelledCheckpoint(ctx.tenantId, target);
        }
        return { cancelled };
      },
    },
    {
      name: 'runs.resume',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['run_id'],
        properties: { run_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['run_id', 'status'],
        properties: {
          run_id: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
        },
      },
      handler: async (params, ctx) => {
        const durable = durableForTenant(ctx.tenantId);
        if (!durable?.store || !durable.resume) {
          if (ctx.tenantId !== defaultTenantId) {
            throw new RpcError(
              'forbidden',
              `Durable runs are not configured for tenant: ${ctx.tenantId}`,
            );
          }
          throw new RpcError('not_found', 'Durable resume is not available');
        }
        const runId = stringParam(params, 'run_id');
        if (!reserveResume(runId)) {
          throw new RpcError('conflict', `Run is already being resumed: ${runId}`, {
            legacy_code: 'run_already_running',
          });
        }
        let checkpoint: Awaited<ReturnType<typeof durable.store.load>>;
        try {
          checkpoint = await durable.store.load(runId);
        } catch (error) {
          releaseResume(runId);
          mapTenantError(error);
        }
        if (!checkpoint) {
          releaseResume(runId);
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        if (!checkpointBelongsToTenant(checkpoint, ctx.tenantId)) {
          releaseResume(runId);
          throw new RpcError('forbidden', `Run does not belong to tenant: ${ctx.tenantId}`);
        }
        if (!isResumableStatus(checkpoint.status)) {
          releaseResume(runId);
          throw new RpcError('conflict', `Run is not resumable: ${runId}`, {
            legacy_code: 'run_not_resumable',
          });
        }
        try {
          await durable.resume(runId);
        } catch (error) {
          releaseResume(runId);
          const code = (error as { code?: unknown }).code;
          if (code === 'run_not_found' || code === 'run_store_required') {
            throw new RpcError(
              'not_found',
              error instanceof Error ? error.message : 'Run not found',
            );
          }
          throw new RpcError('conflict', error instanceof Error ? error.message : 'Resume failed');
        }
        return { run_id: runId, status: 'queued' };
      },
    },
  ];

  /**
   * queued-cancel 的终态 checkpoint。store 无 `save` / 该 tenant 无 durable
   * → 跳过（不报错、不建内存账本）。
   */
  async function writeQueuedCancelledCheckpoint(
    tenantId: string,
    run: LiveRunSnapshotLike,
  ): Promise<void> {
    const store = durableForTenant(tenantId)?.store;
    const save = store?.save;
    if (store === undefined || typeof save !== 'function') return;
    const now = Date.now();
    const checkpoint: DurableCheckpointLike = {
      run_id: run.run_id,
      session_id: run.session_id,
      agent_id: run.agent_id,
      status: 'cancelled',
      messages: [],
      metadata: { reason: 'cancelled_while_queued' },
      created_at: now,
      updated_at: now,
      tenant_id: tenantId,
    };
    try {
      await save.call(store, checkpoint);
    } catch (error) {
      // checkpoint 写入是 best-effort：取消已经生效，不得因此回 500。
      console.warn('[vessel] runs.cancel: checkpoint save failed', {
        run_id: run.run_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
