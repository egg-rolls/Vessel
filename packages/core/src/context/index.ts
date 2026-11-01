/**
 * @vessel-agent/core/context 模块
 * @module @vessel-agent/core/context
 */

export type { ContextConfig, WorkingContext } from '../types/context.js';
export {
  compactMessagesForFork,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
  MemoryWorkingContext,
} from './context-manager.js';
