/**
 * workflow.* 方法（list / get / start / resume / cancel）。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import {
  dedupeWorkflowSummaries,
  isSafeWorkflowName,
  parseWorkflowLimit,
  parseWorkflowStatus,
  sortWorkflowSummaries,
  toWireWorkflowDetail,
  toWireWorkflowSummary,
  type WorkflowGatewayOptions,
} from '../../workflow.js';
import { stringParam } from './common.js';
import { workflowDetailSchema, workflowSummarySchema } from './schemas.js';

export interface WorkflowMethodsDeps {
  /** 非 default tenant 未配置 → forbidden；default 保持 0.4 not_found。 */
  requireWorkflows(tenantId: string): WorkflowGatewayOptions;
  /** 原子占位：同一 workflow run 同时只允许一个 resume。 */
  reserveWorkflowResume(runId: string): boolean;
  releaseWorkflowResume(runId: string): void;
}

export function throwWorkflowError(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'workflow_not_found':
      throw new RpcError('not_found', message);
    case 'workflow_invalid':
      throw new RpcError('invalid_params', message);
    case 'workflow_already_running':
      throw new RpcError('conflict', message, { legacy_code: 'workflow_already_running' });
    case 'workflow_not_resumable':
      throw new RpcError('conflict', message, { legacy_code: 'workflow_not_resumable' });
    case 'workflow_cancelled':
      throw new RpcError('conflict', message, { legacy_code: 'workflow_invalid' });
    case 'workflow_disabled':
      throw new RpcError('not_found', message);
    default:
      throw new RpcError('internal', 'Workflow operation failed');
  }
}

/** inputs 只接受扁平 string map；上限防止请求体外的二次膨胀 */
export function parseWorkflowInputs(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 64) return null;
  const inputs: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 64) return null;
    if (typeof value !== 'string' || value.length > 10_000) return null;
    inputs[key] = value;
  }
  return inputs;
}

export function createWorkflowMethods(deps: WorkflowMethodsDeps): RpcMethodDefinition[] {
  const { requireWorkflows, reserveWorkflowResume, releaseWorkflowResume } = deps;
  return [
    {
      name: 'workflow.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['workflows'],
        properties: {
          workflows: { type: 'array', items: workflowSummarySchema },
        },
      },
      handler: async (params, ctx) => {
        const workflows = requireWorkflows(ctx.tenantId);
        const rawStatus = typeof params.status === 'string' ? params.status : null;
        const status = parseWorkflowStatus(rawStatus);
        if (rawStatus !== null && status === null) {
          throw new RpcError('invalid_params', 'Invalid workflow status filter');
        }
        const limit = parseWorkflowLimit(
          typeof params.limit === 'number' ? String(params.limit) : null,
        );
        if (limit === null) throw new RpcError('invalid_params', 'Invalid workflow limit');
        try {
          const list = await workflows.listRuns({
            ...(status !== null ? { status } : {}),
            limit,
          });
          const summaries = list
            .map((run) => toWireWorkflowSummary(run))
            .filter((run): run is NonNullable<typeof run> => run !== null);
          return {
            workflows: sortWorkflowSummaries(dedupeWorkflowSummaries(summaries)).slice(0, limit),
          };
        } catch (error) {
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: {
          workflow_run_id: { type: 'string', minLength: 1 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['workflow'],
        properties: { workflow: workflowDetailSchema },
      },
      handler: async (params, ctx) => {
        const workflows = requireWorkflows(ctx.tenantId);
        const id = stringParam(params, 'workflow_run_id');
        try {
          const run = await workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const detail = toWireWorkflowDetail(run);
          if (!detail) throw new RpcError('internal', 'Invalid workflow run payload');
          return { workflow: detail };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.start',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          inputs: { type: 'object' },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['workflow_run_id', 'status'],
        properties: {
          workflow_run_id: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
        },
      },
      handler: async (params, ctx) => {
        const workflows = requireWorkflows(ctx.tenantId);
        const name = stringParam(params, 'name').trim();
        if (!isSafeWorkflowName(name)) {
          throw new RpcError('invalid_params', 'Invalid workflow name');
        }
        const inputs = parseWorkflowInputs(params.inputs);
        if (inputs === null) {
          throw new RpcError('invalid_params', 'inputs must be a flat string map (max 64 entries)');
        }
        let definitionPath: string | undefined;
        try {
          definitionPath = workflows.resolveDefinition(name);
        } catch {
          throw new RpcError('internal', 'Failed to resolve workflow definition');
        }
        if (definitionPath === undefined) {
          throw new RpcError('not_found', `Workflow not found: ${name}`);
        }
        try {
          const started = await workflows.start(definitionPath, {
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          });
          return { workflow_run_id: started.workflowRunId, status: 'queued' };
        } catch (error) {
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.resume',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: {
          workflow_run_id: { type: 'string', minLength: 1 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['workflow_run_id', 'status'],
        properties: {
          workflow_run_id: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
        },
      },
      handler: async (params, ctx) => {
        const workflows = requireWorkflows(ctx.tenantId);
        const id = stringParam(params, 'workflow_run_id');
        if (!reserveWorkflowResume(id)) {
          throw new RpcError('conflict', `Workflow run is already resuming: ${id}`, {
            legacy_code: 'workflow_already_running',
          });
        }
        try {
          const run = await workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const summary = toWireWorkflowSummary(run);
          if (!summary) throw new RpcError('internal', 'Invalid workflow run payload');
          if (summary.status === 'running') {
            throw new RpcError('conflict', `Workflow run is already running: ${id}`, {
              legacy_code: 'workflow_already_running',
            });
          }
          if (summary.status === 'completed' || summary.status === 'cancelled') {
            throw new RpcError('conflict', `Workflow run is not resumable: ${id}`, {
              legacy_code: 'workflow_not_resumable',
            });
          }
          const resumed = await workflows.resume(id);
          void resumed.done.finally(() => releaseWorkflowResume(id)).catch(() => undefined);
          return { workflow_run_id: resumed.workflowRunId, status: 'queued' };
        } catch (error) {
          releaseWorkflowResume(id);
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
    {
      name: 'workflow.cancel',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['workflow_run_id'],
        properties: {
          workflow_run_id: { type: 'string', minLength: 1 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['workflow_run_id', 'status'],
        properties: {
          workflow_run_id: { type: 'string' },
          status: { type: 'string', enum: ['cancelled'] },
        },
      },
      handler: async (params, ctx) => {
        const workflows = requireWorkflows(ctx.tenantId);
        const id = stringParam(params, 'workflow_run_id');
        try {
          const run = await workflows.getRun(id);
          if (!run) throw new RpcError('not_found', `Workflow run not found: ${id}`);
          const summary = toWireWorkflowSummary(run);
          if (!summary) throw new RpcError('internal', 'Invalid workflow run payload');
          if (summary.status === 'cancelled') {
            return { workflow_run_id: id, status: 'cancelled' };
          }
          if (summary.status === 'completed' || summary.status === 'failed') {
            throw new RpcError('invalid_params', 'Run is not cancellable');
          }
          await workflows.cancel(id);
          return { workflow_run_id: id, status: 'cancelled' };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throwWorkflowError(error);
        }
      },
    },
  ];
}
