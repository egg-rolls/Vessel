/**
 * LimitChecker 实现
 * @module @vessel/core/limits
 */

import type { LimitChecker, UsageLimits, UsageStats, TerminationPolicy } from '../types/limits.js';

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
    if (limits.request_limit !== undefined && stats.request_count >= limits.request_limit) {
      return false;
    }
    if (limits.tool_calls_limit !== undefined && stats.tool_calls_count >= limits.tool_calls_limit) {
      return false;
    }
    if (limits.input_tokens_limit !== undefined && stats.input_tokens >= limits.input_tokens_limit) {
      return false;
    }
    if (limits.output_tokens_limit !== undefined && stats.output_tokens >= limits.output_tokens_limit) {
      return false;
    }
    if (limits.total_cost_limit !== undefined && stats.total_cost >= limits.total_cost_limit) {
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
    if (stats.request_count >= policy.max_iterations) {
      return true;
    }

    // 检查最大运行时间
    if (policy.max_runtime_seconds !== undefined) {
      const elapsed = (Date.now() - stats.start_time) / 1000;
      if (elapsed >= policy.max_runtime_seconds) {
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
    stats.request_count++;
  }

  /**
   * 增加工具调用计数
   * @param stats 使用量统计
   */
  incrementToolCall(stats: UsageStats): void {
    stats.tool_calls_count++;
  }

  /**
   * 添加 token 使用量
   * @param stats 使用量统计
   * @param input 输入 token 数
   * @param output 输出 token 数
   */
  addTokens(stats: UsageStats, input: number, output: number): void {
    stats.input_tokens += input;
    stats.output_tokens += output;
    stats.total_tokens += input + output;
  }

  /**
   * 添加成本
   * @param stats 使用量统计
   * @param cost 成本金额
   */
  addCost(stats: UsageStats, cost: number): void {
    stats.total_cost += cost;
  }
}

export type { LimitChecker, UsageLimits, UsageStats, TerminationPolicy };
