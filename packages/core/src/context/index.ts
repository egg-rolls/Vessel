/**
 * @vessel-agent/core/context 模块
 * @module @vessel-agent/core/context
 */

export type { ContextAnchor, ContextConfig, WorkingContext } from '../types/context.js';
export {
  CONTEXT_ANCHOR_RATIO_MAX,
  CONTEXT_ANCHOR_RATIO_MIN,
  clampAnchorRatio,
  normalizeContextAnchor,
} from './anchor.js';
export { formatClearedToolResult, isClearedToolResult } from './cleared-tool-result.js';
export {
  compactMessagesForSeed,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  MemoryWorkingContext,
  planClearedToolResults,
  withClearedToolResults,
} from './context-manager.js';
export { createSessionBreaker } from './session-breaker.js';
