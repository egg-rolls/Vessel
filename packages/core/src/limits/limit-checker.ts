/**
 * LimitChecker 实现
 * @module @vessel/core/limits
 */

import type { LimitChecker, TerminationPolicy, UsageLimits, UsageStats } from '../types/limits.js';

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
    if (limits.requestLimit !== undefined && stats.requestCount >= limits.requestLimit) {
      return false;
    }
    if (limits.toolCallsLimit !== undefined && stats.toolCallsCount >= limits.toolCallsLimit) {
      return false;
    }
    if (limits.inputTokensLimit !== undefined && stats.inputTokens >= limits.inputTokensLimit) {
      return false;
    }
    if (limits.outputTokensLimit !== undefined && stats.outputTokens >= limits.outputTokensLimit) {
      return false;
    }
    if (limits.totalCostLimit !== undefined && stats.totalCost >= limits.totalCostLimit) {
      return false;
    }
    return true;
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

export type { LimitChecker, UsageLimits, UsageStats, TerminationPolicy };
