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
import { capToolEvent } from '../../tool-events.js';
import type { TimelineRunEventsPort, TimelineWireEvent } from '../timeline-protocol.js';
import { metricsSnapshotSchema, runEventSchema } from './schemas.js';

export interface ObservabilityMethodsDeps {
  /** 与实时流相同的出站脱敏器（0.15 E6）。 */
  redactor?: TraceRedactor;
  trace?: {
    prune?(options: Record<string, unknown>): Promise<unknown>;
    readEvents?(filter: Record<string, unknown>): Promise<RunEvent[]>;
  };
  /**
   * 0.54 C：`events.list` 的读源（时间线按 run 读，`seq` = `timeline_seq`）。
   *
   * 缺省 ⇒ `events.list` 返回 `not_supported`。**不**回落到 `trace.readEvents`：
   * 那条路的 `seq` 是 per-run 序号，静默回退就等于两条语义同名的 RPC。
   */
  timelineRunEvents?: TimelineRunEventsPort;
  metricsControl?: {
    reset?(): void;
    rebuild?(): Promise<MetricsSnapshot>;
  };
  metrics?: MetricsProvider;
}

/** 与 core `readTraceEvents` 同一口径的默认页大小（`limit` 缺省 50 / 硬顶 500）。 */
const EVENTS_LIST_DEFAULT_LIMIT = 50;
const EVENTS_LIST_MAX_LIMIT = 500;

/**
 * 参数 → 「要什么」的纯函数（不读盘）。
 *
 * 过滤口径从旧实现（core `readTraceEvents`）原样搬过来，**只有 `seq` 的来源变了**：
 * - `since_seq` 排他：`seq > since_seq`（现在是 `timeline_seq`）；
 * - `since_ts` 含（`ts >= since_ts`，与旧实现一致）；
 * - `types` 精确匹配、`type_prefix` 前缀匹配，两者互斥（调用方已校验）；
 * - `limit` 缺省 50、硬顶 500、`0` ⇒ 空数组。
 */
function selectEventsListPage(
  events: readonly TimelineWireEvent[],
  params: Record<string, unknown>,
): TimelineWireEvent[] {
  const rawLimit = typeof params.limit === 'number' ? Math.floor(params.limit) : undefined;
  const limit = Math.min(
    EVENTS_LIST_MAX_LIMIT,
    rawLimit === undefined ? EVENTS_LIST_DEFAULT_LIMIT : Math.max(0, rawLimit),
  );
  if (limit === 0) return [];
  const sinceSeq = typeof params.since_seq === 'number' ? params.since_seq : undefined;
  const sinceTs = typeof params.since_ts === 'number' ? params.since_ts : undefined;
  const types = Array.isArray(params.types)
    ? (params.types.filter((type): type is string => typeof type === 'string') as string[])
    : undefined;
  const typePrefix = typeof params.type_prefix === 'string' ? params.type_prefix : undefined;
  const selected: TimelineWireEvent[] = [];
  for (const event of events) {
    if (sinceSeq !== undefined && event.seq <= sinceSeq) continue;
    if (sinceTs !== undefined && event.ts < sinceTs) continue;
    if (types !== undefined && !types.includes(event.type)) continue;
    if (typePrefix !== undefined && !event.type.startsWith(typePrefix)) continue;
    selected.push(event);
    if (selected.length >= limit) break;
  }
  return selected;
}

/** 时间线记录 → `events.list` 的线上事件（`seq` = `timeline_seq`，不做任何重编号）。 */
function toRunEvent(record: TimelineWireEvent): RunEvent {
  return {
    type: record.type,
    run_id: record.run_id ?? '',
    seq: record.seq,
    ts: record.ts,
    data: (record.data ?? {}) as RunEvent['data'],
  };
}

/** events.list */
export function createEventsMethods(deps: ObservabilityMethodsDeps): RpcMethodDefinition[] {
  const { timelineRunEvents, redactor } = deps;
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
        },
      },
      result_schema: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', items: runEventSchema },
        },
      },
      handler: async (params) => {
        if (timelineRunEvents === undefined) {
          // 端口没装配就是没这个能力（`vessel errors` 把 `not_supported` 与 `not_found`
          // 同等处理 ⇒ 行为不变）。**不**回落到旧 trace：见 `timelineRunEvents` 的注释。
          throw new RpcError('not_supported', 'Timeline event reader is not available');
        }
        if (params.types !== undefined && params.type_prefix !== undefined) {
          throw new RpcError('invalid_params', 'types and type_prefix are mutually exclusive');
        }
        const runId = typeof params.run_id === 'string' ? params.run_id : undefined;
        try {
          // 0.54 C（ADR-105 D5）：同一 RPC 名换源 —— 时间线的 run 索引，`seq` = `timeline_seq`。
          // CONTRACT-0.49 C5：读取端不按 tenant_id 过滤（旧事件含 legacy id 原样可见）。
          const records = await timelineRunEvents.read(runId === undefined ? {} : { runId });
          const page = selectEventsListPage(records, params);
          return {
            // 读路径与实时流一致：先脱敏，再按 8 KiB 裁剪工具参数/结果。
            events: page.map((record) => {
              const event = toRunEvent(record);
              return capToolEvent(redactor ? redactor.redact(event) : event);
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('invalid_params')) {
            throw new RpcError('invalid_params', message);
          }
          throw new RpcError('internal', 'Failed to read timeline');
        }
      },
    },
  ];
}

/** metrics.get / metrics.reset */
export function createMetricsMethods(deps: ObservabilityMethodsDeps): RpcMethodDefinition[] {
  const { metricsControl, metrics } = deps;

  /** 单执行面的 live metrics provider。 */
  function metricsProvider(): MetricsProvider | undefined {
    return metrics;
  }

  return [
    {
      name: 'metrics.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['live', 'trace'] },
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
      handler: async (params) => {
        const source = params.source === 'trace' ? 'trace' : 'live';
        if (source === 'trace') {
          if (!metricsControl?.rebuild) {
            throw new RpcError('not_found', 'Trace metrics rebuild is not available');
          }
          const snapshot = await metricsControl.rebuild();
          return { metrics: normalizeMetricsSnapshot(snapshot), source };
        }
        const provider = metricsProvider();
        if (!provider) throw new RpcError('not_found', 'Metrics are not available');
        return { metrics: normalizeMetricsSnapshot(provider()), source };
      },
    },
    {
      name: 'metrics.reset',
      permission: 'write',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      handler: () => {
        if (!metricsControl?.reset) {
          throw new RpcError('not_found', 'Metrics reset is not available');
        }
        metricsControl.reset();
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
      handler: async (params) => {
        if (!trace?.prune) throw new RpcError('not_found', 'Trace prune is not available');
        return trace.prune(params);
      },
    },
  ];
}
