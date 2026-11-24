/**
 * 平台网关资源指标（日志/指标分离的「指标」侧）。
 *
 * 原先这些值每 60s 以 `logEvent('warn','gateway.resources',…)` 塞进事件日志 ——
 * 资源统计是**统计指标**不是**时间事件**，那样只刷噪音。现在改为登记进 Prometheus
 * registry，由 `/metrics` 端点按 pull 模型暴露（scrape 时求值），事件日志不再出现
 * 周期资源行。监控可视化留外部 Prometheus/Grafana，这里不自建 UI。
 *
 * 指标都是**平台网关进程自身**的开销（进程内存 + 代理并发），不是某个被代理 node
 * 的指标，故用 `role="platform"` 标识来源（node 维度由外部 scrape 的 instance/job
 * 标签或各 node 自己的指标承担）。命名走 Prometheus 惯例：基础单位（bytes/seconds）、
 * 累计量 `_total` 后缀（counter）、瞬时量 gauge。
 *
 * @module @vessel-agent/serve/platform/metrics
 */

import { PrometheusRegistry } from '../prometheus.js';
import type { PlatformProxyStats } from './proxy.js';

/** 指标来源：代理统计快照 + 版本（组合根注入，平台不自己造数据）。 */
export interface PlatformMetricsSource {
  stats: () => PlatformProxyStats;
  version: string;
}

/**
 * 登记平台资源指标族。`collect` 闭包在 scrape 时读 `process` / `stats()`，
 * 都是廉价的瞬时读取，无需周期定时器。
 */
export function createPlatformMetrics(source: PlatformMetricsSource): PrometheusRegistry {
  const registry = new PrometheusRegistry();
  const labels = { role: 'platform' } as const;
  const stats = source.stats;

  // 构建/版本信息（info 式 gauge：值恒 1，身份在标签里）。
  registry.register({
    name: 'vessel_gateway_info',
    type: 'gauge',
    help: 'Platform gateway build information (value is always 1).',
    collect: () => [{ value: 1, labels: { ...labels, version: source.version } }],
  });

  // 进程资源（gauge，瞬时值）。
  registry.register({
    name: 'vessel_process_uptime_seconds',
    type: 'gauge',
    help: 'Platform gateway process uptime in seconds.',
    collect: () => [{ value: process.uptime(), labels }],
  });
  registry.register({
    name: 'vessel_process_resident_memory_bytes',
    type: 'gauge',
    help: 'Platform gateway process resident set size in bytes.',
    collect: () => [{ value: process.memoryUsage().rss, labels }],
  });
  registry.register({
    name: 'vessel_process_heap_used_bytes',
    type: 'gauge',
    help: 'Platform gateway process used heap size in bytes.',
    collect: () => [{ value: process.memoryUsage().heapUsed, labels }],
  });

  // 代理 HTTP（累计 = counter，瞬时 = gauge）。
  registry.register({
    name: 'vessel_proxy_http_requests_total',
    type: 'counter',
    help: 'Total HTTP requests proxied by the platform gateway.',
    collect: () => [{ value: stats().http_requests, labels }],
  });
  registry.register({
    name: 'vessel_proxy_http_failures_total',
    type: 'counter',
    help: 'Total failed HTTP requests proxied by the platform gateway.',
    collect: () => [{ value: stats().http_failures, labels }],
  });
  registry.register({
    name: 'vessel_proxy_http_inflight',
    type: 'gauge',
    help: 'HTTP requests currently in flight through the platform proxy.',
    collect: () => [{ value: stats().http_inflight, labels }],
  });
  registry.register({
    name: 'vessel_proxy_http_passthrough_streams_total',
    type: 'counter',
    help: 'Total streaming responses forwarded via native passthrough.',
    collect: () => [{ value: stats().http_passthrough_streams, labels }],
  });
  // 流式转发实现（pump / passthrough）：info 式 gauge，当前模式在标签里、值恒 1。
  registry.register({
    name: 'vessel_proxy_http_stream_mode',
    type: 'gauge',
    help: 'Active HTTP streaming implementation (value 1 for the current mode label).',
    collect: () => [{ value: 1, labels: { ...labels, mode: stats().http_stream_mode } }],
  });

  // 代理 WS（累计 = counter，瞬时 = gauge）。
  registry.register({
    name: 'vessel_proxy_ws_opened_total',
    type: 'counter',
    help: 'Total WebSocket connections opened through the platform proxy.',
    collect: () => [{ value: stats().ws_opened, labels }],
  });
  registry.register({
    name: 'vessel_proxy_ws_active',
    type: 'gauge',
    help: 'WebSocket connections currently active through the platform proxy.',
    collect: () => [{ value: stats().ws_active, labels }],
  });
  registry.register({
    name: 'vessel_proxy_ws_rejected_total',
    type: 'counter',
    help: 'Total WebSocket upgrades rejected by the platform proxy.',
    collect: () => [{ value: stats().ws_rejected, labels }],
  });
  registry.register({
    name: 'vessel_proxy_ws_pending_bytes',
    type: 'gauge',
    help: 'Bytes currently pending send across platform proxy WebSocket bridges.',
    collect: () => [{ value: stats().ws_pending_bytes, labels }],
  });

  return registry;
}
