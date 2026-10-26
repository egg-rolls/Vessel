/**
 * @vessel-agent/core/runtime 模块
 * @module @vessel-agent/core/runtime
 */

export type { AgentRuntimeOptions, Plugin, PluginHost } from '../types/plugin.js';
export { AgentRuntime } from './agent-runtime.js';
export { toErrorEnvelope } from './error-envelope.js';
export { PermissionTimeoutError } from './permission-policy.js';
export { MemoryPluginHost } from './plugin-host.js';
export {
  type PrefixChangeReason,
  PromptPrefixChangedError,
  type PromptPrefixCheckInput,
  type PromptPrefixCheckResult,
  PromptPrefixGuard,
} from './prompt-prefix-guard.js';
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
