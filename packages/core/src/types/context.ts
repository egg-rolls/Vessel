/**
 * Context 类型定义
 * @module @vessel/core/context
 */

import type { Message } from './provider.js';

/** 上下文管理器接口 */
export interface ContextManager {
  add(msg: Message): void;
  readonly messages: Message[];
  /** @returns 本次移除的消息数（0 = 未压缩） */
  compact(): number;
  clear(): void;
  readonly tokenCount: number;
  setSessionId(sessionId: string): void;
  getSessionId(): string;
  /** 用 LLM 响应的真实 token 数替代估算（Auto Compact 使用） */
  updateRealTokens(total: number): void;
}

/** 上下文配置 */
export interface ContextConfig {
  maxTokens?: number;
  maxMessages?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
  /** 压缩完成回调（removedCount, remainingCount），供 TUI 显示提示 */
  onCompact?: (removed: number, remaining: number) => void;
}
