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
  applyReadSideMaskers,
  BANNED_PREFIX_REASONS,
  CONTEXT_ANCHOR_RATIO_MAX,
  CONTEXT_ANCHOR_RATIO_MIN,
  clampAnchorRatio,
  clearedToolCallIds,
  compactMessagesForSeed,
  countClearedPlaceholders,
  createSessionBreaker,
  diffRequestSequence,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  formatClearedToolResult,
  isClearedToolResult,
  isPrefixSequence,
  isSegmentBoundaryCause,
  isSegmentBoundaryKind,
  KEEP_RECENT_MAX,
  KEEP_RECENT_TOKEN_RATIO,
  MemoryWorkingContext,
  measureRetainedToolResultVolume,
  NON_PAYLOAD_FIELDS,
  type NonPayloadField,
  normalizeClearedToolCallIds,
  normalizeContextAnchor,
  PAYLOAD_FIELDS,
  type PayloadField,
  type ProjectionProblem,
  type ProviderPayloadMessage,
  type ProviderPayloadToolCall,
  planClearedToolResults,
  projectionProblems,
  type RequestSequenceDiff,
  type RequestSequenceDiffKind,
  renderContextOverflowNotice,
  renderContextTrimNotice,
  renderSystemRevisionNotice,
  SEGMENT_BOUNDARY_KINDS,
  SEGMENT_CAUSE_RECORD_EVENTS,
  SEGMENT_KIND_BY_CAUSE,
  SEGMENT_KIND_BY_PREFIX_REASON,
  SEGMENT_NEW_CAUSES,
  SEGMENT_POP_CAUSES,
  type SegmentBoundaryCause,
  type SegmentBoundaryKind,
  segmentRecordEvents,
  shouldCompactForToolResultVolume,
  TOOL_RESULT_VOLUME_THRESHOLD_RATIO,
  type ToolResultKeepOptions,
  type ToolResultVolumeMeasurement,
  type ToolResultVolumeOptions,
  toProviderPayload,
  withClearedToolResults,
  withReadSideMask,
} from './context/index.js';

// 事件流
export {
  BROADCAST_PREVIEW_LIMIT,
  FileEventStore,
  MemoryEventStream,
  type MemoryEventStreamOptions,
  replayRun,
  summarizeBroadcastEvent,
  summarizeLlmRequestEvent,
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
// Runtime（0.52）：PII / 密钥脱敏 + 内存句柄 vault + 审批解锁
export {
  createPiiRevealTool,
  detect as detectPiiHits,
  findApprovalId,
  findHandles as findPiiHandles,
  getPiiVault,
  isHandleId as isPiiHandleId,
  isValidCnIdCard,
  mask as maskPii,
  neutralize as neutralizePiiHandles,
  PII_CAPACITY_NOTICE,
  PII_DEAD_REFERENCE_LIST_LIMIT,
  PII_ENTROPY_MIN_BITS,
  PII_ENTROPY_MIN_LENGTH,
  PII_ENV_DETAIL_MARK,
  PII_HANDLE_ALPHABET,
  PII_HANDLE_ERROR_CODES,
  PII_HANDLE_ID_LENGTH,
  PII_HANDLE_PATTERN_SOURCE,
  PII_HANDLE_TTL_MS,
  PII_INVALIDATION_NOTICE,
  PII_MAX_HANDLES_PER_SESSION,
  PII_MAX_NOTIFIED_BATCHES,
  PII_MAX_SESSIONS,
  PII_NEUTRALIZED,
  PII_NOTICE_MIN_INTERVAL_MS,
  PII_REVEAL_AUDIT_EVENT,
  PII_REVEAL_DENIED_CODE,
  PII_REVEAL_TOOL_NAME,
  type PiiAuditEntry,
  type PiiCategory,
  type PiiDeadReference,
  type PiiDetectOptions,
  type PiiHandleFailure,
  type PiiHandleFailureReason,
  type PiiHandleOccurrence,
  PiiHandleUnresolvedError,
  type PiiHit,
  type PiiNoticeLocale,
  type PiiProtectBatchResult,
  type PiiProtectResult,
  type PiiResolveResult,
  PiiRevealNotApprovedError,
  PiiVault,
  type PiiVaultOptions,
  passesLuhn,
  piiDeadBatchHash,
  piiHandleOf,
  piiHandlePattern,
  piiMaskOf,
  renderDeadReferencesNotice,
  setPiiVault,
  shannonEntropy,
  substitute as substitutePiiHandles,
} from './pii/index.js';
// Provider
export {
  AnthropicProvider,
  MemoryLLMProvider,
  OpenAICompatibleProvider,
  ProviderHttpError,
} from './provider/index.js';
// 运行时
export {
  classifyProviderRetry,
  createToolPipeline,
  createToolPipelineFor,
  DEFAULT_PROVIDER_RETRY_POLICY,
  ExecutionUnit,
  type ExecutionUnitRequest,
  type InstalledPlugins,
  installPluginsIntoHost,
  MemoryPluginHost,
  normalizeRetryPolicy,
  PermissionTimeoutError,
  type PrefixChangeReason,
  PromptPrefixChangedError,
  type PromptPrefixCheckInput,
  type PromptPrefixCheckResult,
  PromptPrefixGuard,
  type ProviderRetryDecision,
  type ProviderRetryScope,
  Runtime,
  retryBackoffMs,
  type TenantRuntimeProfile,
  type ToolPipeline,
  type ToolPipelineDeps,
  type ToolPipelineFactoryDeps,
  type ToolPipelineOptions,
  type ToolPipelineResult,
  type ToolPipelineStages,
  toErrorEnvelope,
} from './runtime/index.js';
// 0.52 S1a：进程退出时武装的续跑标记（纯内存注册表，额度见 graceful-restart）
export {
  createResumeMarkerRegistry,
  type ResumeMarkerRegistryState,
} from './runtime/resume-markers.js';
// 0.52 S1c：启动恢复的判定核心（纯函数：幂等键 / 准入判定 / 清标记守卫）
export {
  findRestartCardRecord,
  isRestartCardMessage,
  RESTART_CARD_SENDER,
  type RestartCandidate,
  type RestartCardKey,
  restartCandidates,
  restartCardAdmitted,
  restartCardKey,
  restartInterruptedIso,
  sameRestartMarker,
} from './runtime/resume-recovery.js';
// Stage 4：Run 写端口（接口 type-only；实现类不导出；装配缝只导出工厂函数）
export {
  createRunJournalFactory,
  type RunJournal,
  type RunJournalFactory,
  type RunJournalFactoryOptions,
} from './runtime/run-journal.js';
// 会话后端
export {
  AtomicWriteError,
  type AtomicWriteOptions,
  assignMessageIdentities,
  atomicWrite,
  compareSessionInfo,
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
  projectedKeepCount,
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
  sessionLogDirExists,
  toSessionInfo,
  withTitleSource,
} from './session/index.js';
// tenant id 校验与单公司根布局（0.49 T5：旧布局解析已删除）
export {
  assertTenantId,
  encodeSessionDirName,
  resolveSingleTenantPaths,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
  type TenantPaths,
} from './tenant/index.js';
// Transport（0.2 R3a-core：进程内实现）
export { InProcessTransport, type InProcessTransportOptions } from './transport/index.js';
// 类型定义
export * from './types/index.js';
