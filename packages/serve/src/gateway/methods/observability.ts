/**
 * 可观测性方法：events.list / metrics.* / trace.prune。
 *
 * 拆成多个工厂是为了在 `gateway.ts` 中保持原方法表顺序
 * （events.subscribe 与工具目录方法夹在中间）。
 *
 * @module @vessel-agent/serve
 */

import type { RunEvent, TraceRedactor } from '@vessel-agent/core';
import {
  type MetricsProvider,
  type MetricsSnapshot,
  normalizeMetricsSnapshot,
} from '../../metrics.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { eventVisible } from '../../tenant.js';
import { capToolEvent } from '../../tool-events.js';
import { tenantParamSchema } from './common.js';
import { metricsSnapshotSchema, runEventSchema } from './schemas.js';

export interface ObservabilityMethodsDeps {
  defaultTenantId: string;
  /** 与实时流相同的出站脱敏器（0.15 E6）。 */
  redactor?: TraceRedactor;
  trace?: {
    prune?(options: Record<string, unknown>): Promise<unknown>;
    readEvents?(filter: Record<string, unknown>, tenantId?: string): Promise<RunEvent[]>;
  };
  metricsControl?: {
    reset?(tenantId?: string): void;
    rebuild?(tenantId: string): Promise<MetricsSnapshot>;
  };
  metrics?: MetricsProvider;
  metricsFor?: (tenantId: string) => MetricsProvider;
}

/** events.list */
export function createEventsMethods(deps: ObservabilityMethodsDeps): RpcMethodDefinition[] {
  const { trace, redactor } = deps;
  return [
    {
      name: 'events.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          since_seq: { type: 'integer', minimum: 0 },
          since_ts: { type: 'integer', minimum: 0 },
          types: { type: 'array', items: { type: 'string' } },
          type_prefix: { type: 'string' },
          limit: { type: 'integer', minimum: 0, maximum: 500 },
          all_tenants: { type: 'boolean' },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', items: runEventSchema },
        },
      },
      handler: async (params, ctx) => {
        if (!trace?.readEvents) throw new RpcError('not_found', 'Trace reader is not available');
        if (params.types !== undefined && params.type_prefix !== undefined) {
          throw new RpcError('invalid_params', 'types and type_prefix are mutually exclusive');
        }
        const filter: Record<string, unknown> = {};
        for (const key of [
          'run_id',
          'since_seq',
          'since_ts',
          'types',
          'type_prefix',
          'limit',
        ] as const) {
          if (params[key] !== undefined) filter[key] = params[key];
        }
        try {
          const events = await trace.readEvents(filter, ctx.tenantId);
          return {
            // 读路径与实时流一致：先脱敏，再按 8 KiB 裁剪工具参数/结果。
            events: events
              .filter((event) => eventVisible(event, ctx.tenantId, ctx.allTenants))
              .map((event) => capToolEvent(redactor ? redactor.redact(event) : event)),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('invalid_params')) {
            throw new RpcError('invalid_params', message);
          }
          throw new RpcError('internal', 'Failed to read trace');
        }
      },
    },
  ];
}

/** metrics.get / metrics.reset */
export function createMetricsMethods(deps: ObservabilityMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, metricsControl, metrics, metricsFor } = deps;

  function metricsProvider(tenantId: string): MetricsProvider | undefined {
    if (tenantId === defaultTenantId) return metrics;
    return metricsFor?.(tenantId);
  }

  return [
    {
      name: 'metrics.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['live', 'trace'] },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['metrics', 'source'],
        properties: {
          metrics: metricsSnapshotSchema,
          source: { type: 'string', enum: ['live', 'trace'] },
        },
      },
      handler: async (params, ctx) => {
        const source = params.source === 'trace' ? 'trace' : 'live';
        if (source === 'trace') {
          if (!metricsControl?.rebuild) {
            throw new RpcError('not_found', 'Trace metrics rebuild is not available');
          }
          const snapshot = await metricsControl.rebuild(ctx.tenantId);
          return { metrics: normalizeMetricsSnapshot(snapshot), source };
        }
        const provider = metricsProvider(ctx.tenantId);
        if (!provider) throw new RpcError('not_found', 'Metrics are not available');
        return { metrics: normalizeMetricsSnapshot(provider()), source };
      },
    },
    {
      name: 'metrics.reset',
      permission: 'write',
      params_schema: tenantParamSchema,
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      handler: (_params, ctx) => {
        if (!metricsControl?.reset) {
          throw new RpcError('not_found', 'Metrics reset is not available');
        }
        metricsControl.reset(ctx.tenantId);
        return { ok: true };
      },
    },
  ];
}

/** trace.prune */
export function createTraceMethods(deps: ObservabilityMethodsDeps): RpcMethodDefinition[] {
  const { trace } = deps;
  return [
    {
      name: 'trace.prune',
      permission: 'admin',
      params_schema: {
        type: 'object',
        properties: {
          older_than_days: { type: 'integer', minimum: 0 },
          max_runs: { type: 'integer', minimum: 0 },
          max_bytes: { type: 'integer', minimum: 0 },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['deleted_runs', 'kept_runs', 'deleted_bytes'],
        properties: {
          deleted_runs: { type: 'integer' },
          kept_runs: { type: 'integer' },
          deleted_bytes: { type: 'integer' },
        },
      },
      handler: async (params, ctx) => {
        if (!trace?.prune) throw new RpcError('not_found', 'Trace prune is not available');
        return trace.prune({ ...params, tenant_id: ctx.tenantId });
      },
    },
  ];
}
