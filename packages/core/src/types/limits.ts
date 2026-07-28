/**
 * Limits 类型定义（camelCase，ADR-019）
 * @module @vessel/core/limits
 */

/** 使用量限制 */
export interface UsageLimits {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

/** 终止策略 */
export interface TerminationPolicy {
  maxIterations: number;
  maxRuntimeSeconds?: number;
}

/** 使用量统计 */
export interface UsageStats {
  requestCount: number;
  toolCallsCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  startTime: number;
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
