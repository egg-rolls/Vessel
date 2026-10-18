/**
 * Observability 接线（0.4 A2）。
 *
 * 激活语义（Addendum C §12.1.1）：
 * - `observability` 块缺省 → 不创建 collector、不暴露 /v1/metrics；
 *   event stream 走 0.3 默认（MemoryEventStream 默认 1000）。
 * - 块存在 → `metrics` 缺省 true；`event_history` 缺省 1000，
 *   显式 0 = 不限制，>0 = 环形缓冲。
 */

import { DEFAULT_OBSERVABILITY_OPTIONS, type VesselConfig } from '../packages/config/src/index';
import {
  type EventBus,
  type EventStream,
  MemoryEventStream,
  MetricsCollector,
} from '../packages/core/src/index';
import { MemoryEventBus } from '../packages/core/src/kernel/index';
import type { MetricsControlLike } from './control-plane-types';

/** 块存在才启用 metrics / 控制面 */
export function isObservabilityConfigured(config: VesselConfig): boolean {
  return config.observability !== undefined;
}

/**
 * 有效的事件历史上限：
 * - 块缺省 → undefined（沿用 MemoryEventStream 默认 1000）；
 * - 块存在 → eventHistory ?? 1000（0 = 不限制）。
 */
export function resolveEventHistory(config: VesselConfig): number | undefined {
  if (!isObservabilityConfigured(config)) return undefined;
  return config.observability?.eventHistory ?? DEFAULT_OBSERVABILITY_OPTIONS.eventHistory;
}

export type EventStreamFactory = (options?: { maxHistory: number }) => EventStream;
export type EventBusFactory = (options?: { maxHistory: number }) => EventBus;

/** legacy / 单 agent 事件流 */
export function createEventStream(config: VesselConfig, factory?: EventStreamFactory): EventStream {
  const limit = resolveEventHistory(config);
  if (limit === undefined) {
    return factory ? factory(undefined) : new MemoryEventStream();
  }
  return factory ? factory({ maxHistory: limit }) : new MemoryEventStream({ maxHistory: limit });
}

/** host 模式事件总线（MemoryEventBus 复用 MemoryEventStream） */
export function createEventBus(config: VesselConfig, factory?: EventBusFactory): EventBus {
  const limit = resolveEventHistory(config);
  if (limit === undefined) {
    return factory ? factory(undefined) : new MemoryEventBus();
  }
  return factory ? factory({ maxHistory: limit }) : new MemoryEventBus({ maxHistory: limit });
}

export type MetricsFactory = (events: EventStream) => MetricsControlLike;

/**
 * 创建 MetricsCollector；块缺省或 `metrics: false` 时返回 undefined。
 * 只订阅事件，不改变 runtime / 事件语义。
 */
export function createMetricsCollector(
  events: EventStream,
  config: VesselConfig,
  factory?: MetricsFactory,
): MetricsControlLike | undefined {
  if (!isObservabilityConfigured(config)) return undefined;
  if (config.observability?.metrics === false) return undefined;

  return factory ? factory(events) : new MetricsCollector(events);
}

/** shutdown 时退订；失败不阻断退出 */
export function disposeMetrics(metrics: MetricsControlLike | undefined): void {
  if (!metrics) return;
  try {
    metrics.dispose();
  } catch {
    // best-effort
  }
}
