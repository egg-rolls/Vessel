/**
 * @vessel-agent/core/limits 模块
 * @module @vessel-agent/core/limits
 */

export type {
  LimitBlock,
  LimitBlockKey,
  LimitChecker,
  TerminationPolicy,
  UsageLimits,
  UsageStats,
} from '../types/limits.js';
export { evaluateUsageLimits, MemoryLimitChecker } from './limit-checker.js';
export { LimitExceededError } from './limit-error.js';
