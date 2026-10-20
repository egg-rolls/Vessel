/**
 * @vessel-agent/workflow — 声明式 workflow 引擎插件。
 *
 * 工厂式插件：由装配层（asm）构造并注入 RuntimeHost / RunnableAgent / PluginHost。
 * 默认导出是工厂函数，因此列入 `FACTORY_PLUGINS`（短名 workflow）。
 */

export { createWorkflowEngine, createWorkflowEngine as default } from './engine.js';
export { WorkflowError } from './errors.js';
export {
  loadWorkflowDefinition,
  nodeWorkflowFs,
  parseWorkflowDefinition,
  resolveDefinition,
  resolveDefinitionPath,
} from './schema.js';
export type {
  ResolvedWorkflowConfig,
  WorkflowControls,
  WorkflowDefaults,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineOptions,
  WorkflowErrorCode,
  WorkflowFs,
  WorkflowOnError,
  WorkflowOutcome,
  WorkflowRetry,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepDefinition,
  WorkflowStepStatus,
  WorkflowStepSummary,
  WorkflowWhen,
  WorkflowWhenStatus,
} from './types.js';

export const DEFAULT_MAX_PARALLEL = 2;
export const DEFAULT_STEP_TIMEOUT_MS = 300_000;
