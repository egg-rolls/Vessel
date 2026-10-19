/**
 * @vessel/core - AI Agent 运行时核心
 * @module @vessel/core
 *
 * 核心运行时库，零 UI 依赖，可独立嵌入。
 * 提供 tool-calling loop、provider 抽象、context/session、events、
 * limits、guardrail、hooks、PluginHost（工具的唯一注册表）。
 */

// 上下文管理器
export { MemoryContextManager } from './context/index.js';

// 事件流
export {
  FileEventStore,
  MemoryEventStream,
  type MemoryEventStreamOptions,
  replayRun,
} from './events/index.js';
// Kernel（0.2 R1：Host / Handles / Cancellation / EventBus / Transport port）
export * from './kernel/index.js';
// 限制检查器
export { MemoryLimitChecker } from './limits/index.js';
// Observability（0.4 C2 聚合 + 0.5 F2 trace）
export {
  createDefaultTraceRedactor,
  FileTraceRecorder,
  type FileTraceRecorderOptions,
  MetricsCollector,
  type MetricsSnapshot,
  type PruneTraceOptions,
  type PruneTraceResult,
  pruneTrace,
  type ReadTraceOptions,
  readTraceEvents,
  rebuildMetrics,
  type TraceRecorderStats,
} from './observability/index.js';
// Provider
export {
  AnthropicProvider,
  MemoryLLMProvider,
  OpenAICompatibleProvider,
} from './provider/index.js';
// 运行时
export {
  AgentRuntime,
  createToolPipeline,
  MemoryPluginHost,
  type ToolPipeline,
  type ToolPipelineDeps,
  type ToolPipelineOptions,
  type ToolPipelineResult,
  type ToolPipelineStages,
} from './runtime/index.js';
// 会话后端
export {
  AtomicWriteError,
  type AtomicWriteOptions,
  atomicWrite,
  type DeleteSessionDataOptions,
  type DeleteSessionDataResult,
  deleteSessionData,
  FileRunStore,
  FileSessionBackend,
  MemoryRunStore,
  MemorySessionBackend,
  type PruneRunsOptions,
  type PruneRunsResult,
  pruneRuns,
  SessionCorruptError,
  SessionDeleteConflictError,
  SQLiteSessionBackend,
  type SQLiteSessionBackendOptions,
} from './session/index.js';
// 多租户（0.5 F4：tenant 解析与目录布局）
export {
  assertTenantId,
  type ResolveTenantIdInput,
  type ResolveTenantInput,
  resolveTenant,
  resolveTenantId,
  resolveTenantPaths,
  type TenantPaths,
  tenantRootPath,
} from './tenant/index.js';
// Transport（0.2 R3a-core：进程内实现）
export { InProcessTransport, type InProcessTransportOptions } from './transport/index.js';
// 类型定义
export * from './types/index.js';
