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

/**
 * 预警形状（0.15 E2）：已到阈值、未到硬上限的限制。
 * 与 `LimitBlock` 不同，不带 `retryable`——预警不改变执行。
 */
export interface LimitWarning {
  scope: 'run';
  key: LimitBlockKey;
  current: number;
  max: number;
  /** 配置来源，例如 `limits.inputTokensLimit` */
  source: string;
  /** 触发预警的比例（0.15 固定 0.8） */
  threshold: number;
  /** 一句可执行建议 */
  hint: string;
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
  /**
   * 等待用户授权累计的毫秒数（ADR-084 Errata）：人工确认不计入 `max_runtime`。
   * 缺省 / 0 表示没有暂停。
   */
  pausedMs?: number;
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
