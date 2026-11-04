/**
 * @vessel-agent/core/context 模块
 * @module @vessel-agent/core/context
 */

export type { ContextConfig, WorkingContext } from '../types/context.js';
export { formatClearedToolResult, isClearedToolResult } from './cleared-tool-result.js';
export {
  compactMessagesForSeed,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  MemoryWorkingContext,
} from './context-manager.js';
export { createSessionBreaker } from './session-breaker.js';
