/**
 * Limits 类型定义
 * @module @vessel/core/limits
 */

/** 使用量限制 */
export interface UsageLimits {
  request_limit?: number;
  tool_calls_limit?: number;
  input_tokens_limit?: number;
  output_tokens_limit?: number;
  total_cost_limit?: number;
}

/** 终止策略 */
export interface TerminationPolicy {
  max_iterations: number;
  max_runtime_seconds?: number;
}

/** 使用量统计 */
export interface UsageStats {
  request_count: number;
  tool_calls_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost: number;
  start_time: number;
}

/** 限制检查器接口 */
export interface LimitChecker {
  checkLimits(stats: UsageStats, limits: UsageLimits): boolean;
  checkTermination(stats: UsageStats, policy: TerminationPolicy): boolean;
  incrementRequest(stats: UsageStats): void;
  incrementToolCall(stats: UsageStats): void;
  addTokens(stats: UsageStats, input: number, output: number): void;
  addCost(stats: UsageStats, cost: number): void;
}
