/**
 * @vessel-agent/core/observability 模块
 *
 * - `MetricsCollector` / `MetricsSnapshot`（0.4 C2）
 * - 既有事件实现（FileEventStore / MemoryEventStream / replayRun）继续从本 subpath 暴露
 *
 * @module @vessel-agent/core/observability
 */

export * from '../events/index.js';
export * from './metrics.js';
export { type ReadTraceOptions, readTraceEvents } from './read-trace.js';
export { rebuildMetrics } from './rebuild-metrics.js';
export {
  type PruneTraceOptions,
  type PruneTraceResult,
  pruneTrace,
} from './trace-prune.js';
export {
  FileTraceRecorder,
  type FileTraceRecorderOptions,
  type TraceRecorderStats,
} from './trace-recorder.js';
export { createDefaultTraceRedactor } from './trace-redactor.js';
