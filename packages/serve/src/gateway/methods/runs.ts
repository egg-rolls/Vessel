/**
 * runs.* 方法（list / get / start / cancel / resume）。
 *
 * @module @vessel/serve
 */

import type { RunnableAgent } from '@vessel/core';
import { type DurableGatewayOptions, isResumableStatus } from '../../durable.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import type { RunEngine, RunRecord } from '../../run-engine.js';
import { mapTenantError, type TenantControlLike } from '../../tenant.js';
import { checkpointBelongsToTenant, stringParam } from './common.js';
import { runStatusSchema } from './schemas.js';

export interface RunMethodsDeps {
  defaultTenantId: string;
  runs: ReadonlyMap<string, RunRecord>;
  publicStatus: RunEngine['publicStatus'];
  submitRun: RunEngine['submitRun'];
  cancelRun: RunEngine['cancelRun'];
  /** 非 default tenant 未注入 → forbidden；default 保持旧码。 */
  requireRuntime(tenantId: string): RunnableAgent;
  durableForTenant(tenantId: string): DurableGatewayOptions | undefined;
  tenants?: TenantControlLike;
  activeCount(tenantId: string): number;
  reserveResume(runId: string): boolean;
  releaseResume(runId: string): void;
}

export function createRunMethods(deps: RunMethodsDeps): RpcMethodDefinition[] {
  const {
    defaultTenantId,
    runs,
    publicStatus,
    submitRun,
    cancelRun,
    requireRuntime,
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

  return [
    {
      name: 'runs.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['runs'],
        properties: {
          runs: { type: 'array', items: runStatusSchema },
        },
      },
      handler: (params, ctx) => {
        const sessionFilter = typeof params.session_id === 'string' ? params.session_id : undefined;
        const statusFilter = typeof params.status === 'string' ? params.status : undefined;
        return {
          runs: [...runs.values()]
            .filter((record) => record.tenant_id === ctx.tenantId)
            .filter((record) => !sessionFilter || record.session_id === sessionFilter)
            .filter((record) => !statusFilter || record.status === statusFilter)
            .map(publicStatus),
        };
      },
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
        const record = runs.get(runId);
        if (record && record.tenant_id === ctx.tenantId) return { run: publicStatus(record) };
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
        const checkpoint = await durable.store.load(runId);
        if (!checkpoint || !checkpointBelongsToTenant(checkpoint, ctx.tenantId)) {
          throw new RpcError('not_found', `Run not found: ${runId}`);
        }
        return { run: checkpoint };
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
        },
      },
      handler: async (params, ctx) => {
        requireRuntime(ctx.tenantId);
        await enforceConcurrentQuota(ctx.tenantId);
        await checkQuota(ctx.tenantId, 'runs.start');
        return submitRun(params, ctx.tenantId);
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
      handler: (params, ctx) => ({
        cancelled: cancelRun(stringParam(params, 'run_id'), ctx.tenantId),
      }),
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
}
