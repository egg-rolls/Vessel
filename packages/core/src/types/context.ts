/**
 * Context 类型定义
 * @module @vessel/core/context
 */

import type { Message } from './provider.js';

/** 上下文管理器接口 */
export interface ContextManager {
  add(msg: Message): void;
  readonly messages: Message[];
  compact(): void;
  clear(): void;
  readonly tokenCount: number;
  setSessionId(sessionId: string): void;
  getSessionId(): string;
}

/** 上下文配置 */
export interface ContextConfig {
  maxTokens?: number;
  maxMessages?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
}
