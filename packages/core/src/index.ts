/**
 * @vessel-agent/core - AI Agent 运行时核心
 * @module @vessel-agent/core
 *
 * 核心运行时库，零 UI 依赖，可独立嵌入。
 * 提供 tool-calling loop、provider 抽象、context/session、events、
 * limits、guardrail、hooks、PluginHost（工具的唯一注册表）。
 */

// 上下文管理器 + 单一 token 估算（0.10 R1-10）
export {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  MemoryWorkingContext,
} from './context/index.js';

// 事件流
export {
  FileEventStore,
  MemoryEventStream,
  type MemoryEventStreamOptions,
  replayRun,
} from './events/index.js';
// 顶层 `RunStatus` 保持 kernel 调度语义（queued/running/...）；
// RunRecord 的 RunStatus 经 `./session` / `./types` 子路径导出。
export type { RunStatus } from './kernel/index.js';
// Kernel（0.2 R1：Host / Handles / Cancellation / EventBus / Transport port）
export * from './kernel/index.js';
// 限制检查器
export {
  evaluateLimitWarnings,
  evaluateTermination,
  evaluateUsageLimits,
  LIMIT_WARNING_THRESHOLD,
  LimitExceededError,
  MemoryLimitChecker,
} from './limits/index.js';
// 日志端口（0.10 R2-14）：Logger / LogLevel / LogFields / LoggerOptions 经 ./types 导出
export { createStderrLogger, noopLogger } from './logging.js';
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
  ProviderHttpError,
} from './provider/index.js';
// 运行时
export {
  createToolPipeline,
  createToolPipelineFor,
  ExecutionUnit,
  MemoryPluginHost,
  PermissionTimeoutError,
  type PrefixChangeReason,
  PromptPrefixChangedError,
  type PromptPrefixCheckInput,
  type PromptPrefixCheckResult,
  PromptPrefixGuard,
  type ToolPipeline,
  type ToolPipelineDeps,
  type ToolPipelineFactoryDeps,
  type ToolPipelineOptions,
  type ToolPipelineResult,
  type ToolPipelineStages,
  toErrorEnvelope,
} from './runtime/index.js';
// 会话后端
export {
  AtomicWriteError,
  type AtomicWriteOptions,
  atomicWrite,
  type DeleteSessionDataOptions,
  type DeleteSessionDataResult,
  deleteSessionData,
  FileRunRecordStore,
  FileSessionStore,
  MemoryRunRecordStore,
  MemorySessionStore,
  mergeHistoryProjection,
  type ProjectableEvent,
  type PruneRunsOptions,
  type PruneRunsResult,
  projectMessages,
  pruneRuns,
  type ReadSessionEventsOptions,
  removeLegacySessionTrace,
  SessionCorruptError,
  SessionDeleteConflictError,
  SessionEventLog,
  type SessionEventLogOptions,
  type SessionLogIndex,
  SQLiteSessionStore,
  type SQLiteSessionStoreOptions,
  sessionLogDirExists,
} from './session/index.js';
// 多租户（0.5 F4：tenant 解析与目录布局）
export {
  assertTenantId,
  encodeSessionDirName,
  type ResolveTenantIdInput,
  type ResolveTenantInput,
  resolveTenant,
  resolveTenantId,
  resolveTenantPaths,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
  type TenantPaths,
  tenantRootPath,
} from './tenant/index.js';
// Transport（0.2 R3a-core：进程内实现）
export { InProcessTransport, type InProcessTransportOptions } from './transport/index.js';
// 类型定义
export * from './types/index.js';
