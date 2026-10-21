/**
 * LimitChecker 实现
 * @module @vessel-agent/core/limits
 */

import type {
  LimitBlock,
  LimitChecker,
  TerminationPolicy,
  UsageLimits,
  UsageStats,
} from '../types/limits.js';

/** 命中上限时的首个 key（与 checkLimits 的检查顺序一致） */
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
  if (limits.toolCallsLimit !== undefined && stats.toolCallsCount >= limits.toolCallsLimit) {
    return {
      scope: 'run',
      key: 'tool_calls_limit',
      current: stats.toolCallsCount,
      max: limits.toolCallsLimit,
      source: 'limits.toolCallsLimit',
      hint: 'Increase limits.toolCallsLimit or reduce tool usage in the task.',
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
    // 检查最大迭代次数
    if (stats.requestCount >= policy.maxIterations) {
      return true;
    }

    // 检查最大运行时间
    if (policy.maxRuntimeSeconds !== undefined) {
      const elapsed = (Date.now() - stats.startTime) / 1000;
      if (elapsed >= policy.maxRuntimeSeconds) {
        return true;
      }
    }

    return false;
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
