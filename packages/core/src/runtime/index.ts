/**
 * @vessel-agent/core/runtime 模块
 * @module @vessel-agent/core/runtime
 */

export type {
  ExecutionUnitOptions,
  Plugin,
  PluginHost,
  RegisterToolOptions,
} from '../types/plugin.js';
export type {
  ToolNameAlias,
  ToolNameAudit,
  ToolNameEntry,
  ToolNameViolation,
} from '../types/tool-name.js';
export { toErrorEnvelope } from './error-envelope.js';
export { ExecutionUnit } from './execution-unit.js';
export { PermissionTimeoutError } from './permission-policy.js';
export { MemoryPluginHost } from './plugin-host.js';
export { type InstalledPlugins, installPluginsIntoHost } from './plugin-install.js';
export {
  type PrefixChangeReason,
  PromptPrefixChangedError,
  type PromptPrefixCheckInput,
  type PromptPrefixCheckResult,
  PromptPrefixGuard,
} from './prompt-prefix-guard.js';
export {
  classifyProviderRetry,
  DEFAULT_PROVIDER_RETRY_POLICY,
  normalizeRetryPolicy,
  type ProviderRetryDecision,
  type ProviderRetryScope,
  retryBackoffMs,
} from './provider-retry.js';
export { createResumeMarkerRegistry, type ResumeMarkerRegistryState } from './resume-markers.js';
export {
  createRunJournalFactory,
  type RunJournal,
  type RunJournalFactory,
  type RunJournalFactoryOptions,
  type RunJournalIdentity,
  type RunJournalTransientIdentity,
  type TimelineDualWriteEvent,
  type TimelineDualWritePort,
} from './run-journal.js';
export { type ExecutionUnitRequest, Runtime, type TenantRuntimeProfile } from './runtime.js';
export {
  assertToolNameLegality,
  auditToolNames,
  describeToolNameProblem,
  findToolNameAlias,
  isToolNameLegal,
  MAX_TOOL_NAME_LENGTH,
  PROVIDER_SAFE_TOOL_NAME,
  resolveToolNameAlias,
  suggestToolName,
  TOOL_NAME_ALIASES,
  TOOL_NAME_PATTERN,
  TOOL_NAME_RULE,
} from './tool-name.js';
export {
  createToolPipeline,
  createToolPipelineFor,
  type ToolPipeline,
  type ToolPipelineDeps,
  type ToolPipelineFactoryDeps,
  type ToolPipelineOptions,
  type ToolPipelineResult,
  type ToolPipelineStages,
} from './tool-pipeline.js';
// tools-engine P2（O4）：执行位置 / 桥溯源回执槽（与 gate receipt 同形；打标方在装配层）。
export {
  isBridgeCall,
  markBridgeCall,
  markToolTransport,
  type ToolTransport,
  takeToolTransport,
} from './tool-provenance.js';
// 0.56 闸上移：工具结果出口闸（≤ 16k token / 头 30% 尾 70% / 落盘路径）。
// 插件作者用 `boundToolResult` + `markToolResultBounded` 自己先裁一遍（第二道闸）时，
// 凭回执让 loop 跳过重裁；`writeToolOutput` / `toolOutputRoot` 是落盘的唯一实现。
// engine 池 S11：`runWithToolOutputScope` 逐调用注入落盘根作用域（无 scope 走 env 链）。
export {
  type BoundedToolResult,
  boundToolResult,
  cutToTokenBudget,
  MAX_TOOL_RESULT_TOKENS,
  markToolResultBounded,
  omitMarker,
  runWithToolOutputScope,
  safeSegment,
  type TokenCut,
  type ToolOutputScope,
  type ToolResultGateOptions,
  type ToolResultGateReceipt,
  takeToolResultGateReceipt,
  toolOutputRoot,
  writeToolOutput,
} from './tool-result-gate.js';
