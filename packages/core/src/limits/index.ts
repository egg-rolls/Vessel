/**
 * @vessel-agent/core/limits 模块
 * @module @vessel-agent/core/limits
 */

export type {
  LimitBlock,
  LimitBlockKey,
  LimitChecker,
  LimitWarning,
  TerminationPolicy,
  UsageLimits,
  UsageStats,
} from '../types/limits.js';
export {
  evaluateLimitWarnings,
  evaluateTermination,
  evaluateUsageLimits,
  LIMIT_WARNING_THRESHOLD,
  MemoryLimitChecker,
} from './limit-checker.js';
export { LimitExceededError } from './limit-error.js';
