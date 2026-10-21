/**
 * Limits 类型定义（camelCase，ADR-019）
 * @module @vessel-agent/core/limits
 */

/** 使用量限制 */
export interface UsageLimits {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

/** 命中的使用量 / 终止上限 key */
export type LimitBlockKey =
  | 'request_limit'
  | 'tool_calls_limit'
  | 'input_tokens_limit'
  | 'output_tokens_limit'
  | 'total_cost_limit'
  | 'max_iterations'
  | 'max_runtime';

/** 命中的使用量上限（冻结形状：事件与 error envelope 共用） */
export interface LimitBlock {
  scope: 'run';
  key: LimitBlockKey;
  current: number;
  max: number;
  /** 配置来源，例如 `limits.inputTokensLimit` */
  source: string;
  /** 一句可执行建议 */
  hint: string;
  retryable: false;
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
