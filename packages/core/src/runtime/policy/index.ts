/**
 * @vessel-agent/core/policy 模块入口（R6a）
 *
 * 实现暂留在 `runtime/` 下；这里只做公开 barrel，不移动文件（R6b 再评估）。
 * 只依赖 port 类型，不依赖 provider / context / session。
 *
 * @module @vessel-agent/core/policy
 */

export type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
} from '../../types/guardrail.js';
export { GuardrailStage } from '../../types/guardrail.js';
export type { Hook, HookContext, HookResult } from '../../types/hook.js';
export { HookType } from '../../types/hook.js';
export type { RuntimePermissionConfig } from '../../types/plugin.js';
export { type GuardrailOutcome, GuardrailRunner } from '../guardrail-runner.js';
export { HookRunner } from '../hook-runner.js';
export { PermissionPolicy } from '../permission-policy.js';
