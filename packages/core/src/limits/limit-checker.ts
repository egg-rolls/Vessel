/**
 * LimitChecker 实现
 * @module @vessel-agent/core/limits
 */

import type {
  LimitBlock,
  LimitBlockKey,
  LimitChecker,
  LimitWarning,
  TerminationPolicy,
  UsageLimits,
  UsageStats,
} from '../types/limits.js';

/** 预警阈值（0.31 起 0.9）；硬上限仍由 evaluateUsageLimits / evaluateTermination 判定 */
export const LIMIT_WARNING_THRESHOLD = 0.9;

/**
 * 已运行秒数（毫秒精度）。扣除等待用户授权的时长（ADR-084 Errata）：
 * 人工确认不是机器执行时间，不应消耗 `max_runtime` 预算。
 */
function elapsedSeconds(stats: UsageStats): number {
  const paused = stats.pausedMs ?? 0;
  return Math.round(((Date.now() - stats.startTime - paused) / 1000) * 1000) / 1000;
}

/** 单个 key 的预警判定：>= threshold × max 且 < max */
function warningFor(
  key: LimitBlockKey,
  current: number,
  max: number | undefined,
  source: string,
  hint: string,
  threshold: number,
): LimitWarning | null {
  if (max === undefined || max <= 0) return null;
  if (current >= max) return null;
  if (current < max * threshold) return null;
  return { scope: 'run', key, current, max, source, threshold, hint };
}

/**
 * 0.15 E2：返回所有已到预警阈值的 key（每个 key 一条）。
 * 只读判定，不改变执行；达到上限的 key 不再返回（硬上限交给 limit.blocked）。
 */
export function evaluateLimitWarnings(
  stats: UsageStats,
  limits: UsageLimits,
  termination: TerminationPolicy,
  threshold = LIMIT_WARNING_THRESHOLD,
): LimitWarning[] {
  const warnings: LimitWarning[] = [];
  const push = (warning: LimitWarning | null): void => {
    if (warning) warnings.push(warning);
  };

  push(
    warningFor(
      'request_limit',
      stats.requestCount,
      limits.requestLimit,
      'limits.requestLimit',
      'Increase limits.requestLimit or reduce the number of LLM requests.',
      threshold,
    ),
  );
  push(
    warningFor(
      'input_tokens_limit',
      stats.inputTokens,
      limits.inputTokensLimit,
      'limits.inputTokensLimit',
      'Increase limits.inputTokensLimit or compact the conversation history.',
      threshold,
    ),
  );
  push(
    warningFor(
      'output_tokens_limit',
      stats.outputTokens,
      limits.outputTokensLimit,
      'limits.outputTokensLimit',
      'Increase limits.outputTokensLimit or lower the per-request max_tokens.',
      threshold,
    ),
  );
  push(
    warningFor(
      'total_cost_limit',
      stats.totalCost,
      limits.totalCostLimit,
      'limits.totalCostLimit',
      'Increase limits.totalCostLimit or use a cheaper model for this task.',
      threshold,
    ),
  );
  push(
    warningFor(
      'max_iterations',
      stats.requestCount,
      termination.maxIterations,
      'termination.maxIterations',
      'Increase termination.maxIterations or reduce tool round-trips in the task.',
      threshold,
    ),
  );
  if (termination.maxRuntimeSeconds !== undefined) {
    const elapsed = elapsedSeconds(stats);
    push(
      warningFor(
        'max_runtime',
        elapsed,
        termination.maxRuntimeSeconds,
        'termination.maxRuntimeSeconds',
        'Increase termination.maxRuntimeSeconds or shorten the task.',
        threshold,
      ),
    );
  }
  return warnings;
}

/** 命中上限时的首个 key（与 checkLimits 的检查顺序一致）。 */
export function evaluateUsageLimits(stats: UsageStats, limits: UsageLimits): LimitBlock | null {
  if (limits.requestLimit !== undefined && stats.requestCount >= limits.requestLimit) {
    return {
      scope: 'run',
      key: 'request_limit',
      current: stats.requestCount,
      max: limits.requestLimit,
      source: 'limits.requestLimit',
      hint: 'Increase limits.requestLimit or reduce the number of LLM requests.',
      retryable: false,
    };
  }
  if (limits.inputTokensLimit !== undefined && stats.inputTokens >= limits.inputTokensLimit) {
    return {
      scope: 'run',
      key: 'input_tokens_limit',
      current: stats.inputTokens,
      max: limits.inputTokensLimit,
      source: 'limits.inputTokensLimit',
      hint: 'Increase limits.inputTokensLimit or compact the conversation history.',
      retryable: false,
    };
  }
  if (limits.outputTokensLimit !== undefined && stats.outputTokens >= limits.outputTokensLimit) {
    return {
      scope: 'run',
      key: 'output_tokens_limit',
      current: stats.outputTokens,
      max: limits.outputTokensLimit,
      source: 'limits.outputTokensLimit',
      hint: 'Increase limits.outputTokensLimit or lower the per-request max_tokens.',
      retryable: false,
    };
  }
  if (limits.totalCostLimit !== undefined && stats.totalCost >= limits.totalCostLimit) {
    return {
      scope: 'run',
      key: 'total_cost_limit',
      current: stats.totalCost,
      max: limits.totalCostLimit,
      source: 'limits.totalCostLimit',
      hint: 'Increase limits.totalCostLimit or use a cheaper model for this task.',
      retryable: false,
    };
  }
  return null;
}

/** 命中的终止上限（与 evaluateUsageLimits 同形状，供事件 / envelope 复用） */
export function evaluateTermination(
  stats: UsageStats,
  policy: TerminationPolicy,
): LimitBlock | null {
  if (stats.requestCount >= policy.maxIterations) {
    return {
      scope: 'run',
      key: 'max_iterations',
      current: stats.requestCount,
      max: policy.maxIterations,
      source: 'termination.maxIterations',
      hint: 'Increase termination.maxIterations or reduce tool round-trips in the task.',
      retryable: false,
    };
  }

  if (policy.maxRuntimeSeconds !== undefined) {
    const elapsed = elapsedSeconds(stats);
    if (elapsed >= policy.maxRuntimeSeconds) {
      return {
        scope: 'run',
        key: 'max_runtime',
        current: elapsed,
        max: policy.maxRuntimeSeconds,
        source: 'termination.maxRuntimeSeconds',
        hint: 'Increase termination.maxRuntimeSeconds or shorten the task.',
        retryable: false,
      };
    }
  }

  return null;
}

/**
 * 限制检查器实现
 */
export class MemoryLimitChecker implements LimitChecker {
  /**
   * 检查是否超出使用量限制
   * @param stats 使用量统计
   * @param limits 使用量限制
   * @returns 是否超出限制
   */
  checkLimits(stats: UsageStats, limits: UsageLimits): boolean {
    return evaluateUsageLimits(stats, limits) === null;
  }

  /**
   * 检查是否满足终止条件
   * @param stats 使用量统计
   * @param policy 终止策略
   * @returns 是否应该终止
   */
  checkTermination(stats: UsageStats, policy: TerminationPolicy): boolean {
    return evaluateTermination(stats, policy) !== null;
  }

  /**
   * 增加请求计数
   * @param stats 使用量统计
   */
  incrementRequest(stats: UsageStats): void {
    stats.requestCount++;
  }

  /**
   * 增加工具调用计数
   * @param stats 使用量统计
   */
  incrementToolCall(stats: UsageStats): void {
    stats.toolCallsCount++;
  }

  /**
   * 添加 token 使用量
   * @param stats 使用量统计
   * @param input 输入 token 数
   * @param output 输出 token 数
   */
  addTokens(stats: UsageStats, input: number, output: number): void {
    stats.inputTokens += input;
    stats.outputTokens += output;
    stats.totalTokens += input + output;
  }

  /**
   * 添加成本
   * @param stats 使用量统计
   * @param cost 成本金额
   */
  addCost(stats: UsageStats, cost: number): void {
    stats.totalCost += cost;
  }
}

export type { LimitChecker, TerminationPolicy, UsageLimits, UsageStats };
