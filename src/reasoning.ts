/**
 * 思考流接线（0.11.1，DECISION-022 §2.3）。
 *
 * `ui.showReasoning` 显式 opt-in；默认 false，未配置时行为与 0.11.0 一致。
 * core 0.11.1 在 `AgentRuntimeOptions` 上提供 `includeReasoning`。core 尚未合并时，
 * 这里用结构化类型（返回值带额外字段）注入——非对象字面量可直接赋给
 * `AgentRuntimeOptions`；core 合并后只需收紧本函数的返回类型。
 *
 * @module vessel/reasoning
 */

import type { VesselConfig } from '../packages/config/src/index';

/** core 0.11.1 的思考流开关；core 合并前保持可选 */
export interface ReasoningRuntimeOption {
  includeReasoning: boolean;
}

/** 是否把模型思考流发布给 UI（只有显式 `true` 才开启） */
export function includeReasoningFor(config: VesselConfig): boolean {
  return config.ui?.showReasoning === true;
}

/**
 * 给 `AgentRuntime.create` 的选项补 `includeReasoning`。
 * 返回 `T & ReasoningRuntimeOption`，调用方无需改原有对象字面量类型。
 */
export function withReasoning<T extends object>(
  config: VesselConfig,
  options: T,
): T & ReasoningRuntimeOption {
  return { ...options, includeReasoning: includeReasoningFor(config) };
}
