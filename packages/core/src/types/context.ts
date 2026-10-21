/**
 * Context 类型定义
 * @module @vessel-agent/core/context
 */

import type { Message } from './provider.js';

/** 摘要器选项（0.6.1 E3） */
export interface ContextSummaryOptions {
  /** 摘要目标 token 预算（取 ContextConfig.maxTokens） */
  maxTokens: number;
}

/**
 * 真实上下文摘要器（0.6.1 E3）。
 * 输入被移除的消息，返回一段可替代它们的摘要文本。
 */
export type ContextSummarizer = (
  messages: Message[],
  options: ContextSummaryOptions,
) => Promise<string>;

/** `context.compacted` 的 reason（0.15 E1） */
export type ContextCompactedReason = 'auto' | 'overflow' | 'manual';

/** 上下文管理器接口 */
export interface ContextManager {
  add(msg: Message): void;
  readonly messages: Message[];
  /** @returns 本次移除的消息数（0 = 未压缩）；同步实现，无 summarizer 时用占位符 */
  compact(): number;
  /**
   * 0.6.1 E3：异步压缩。配置 summarizer 时产生真实摘要，
   * 否则回退到同步 compact() 的占位符。实现可选，旧 ContextManager 不受影响。
   */
  compactAsync?(): Promise<number>;
  /**
   * 0.6.1 E3：按 `autoCompact` / `compactThreshold` 决定是否压缩。
   * 返回本次移除的消息数（0 = 未触发）。
   */
  autoCompactAsync?(): Promise<number>;
  clear(): void;
  readonly tokenCount: number;
  /** 0.15：上下文 token 预算上限；实现能提供时用于快照 `context_max`，否则缺省 */
  readonly maxTokens?: number;
  setSessionId(sessionId: string): void;
  getSessionId(): string;
  /** 用 LLM 响应的真实 token 数替代估算（Auto Compact 使用） */
  updateRealTokens(total: number): void;
}

/** 上下文配置 */
export interface ContextConfig {
  maxTokens?: number;
  /**
   * 消息条数安全上限。0.10 起不再硬截断：超限先摘要（system 永不丢），
   * 并且只有显式配置时才用；缺省按 `maxTokens` 推导。
   */
  maxMessages?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
  /** 压缩完成回调（removedCount, remainingCount），供 TUI 显示提示 */
  onCompact?: (removed: number, remaining: number) => void;
  /**
   * 0.6.1 E3：真实摘要器。缺省时保留占位符摘要（向后兼容）。
   * 配置后由 `compactAsync()` / `autoCompactAsync()` 消费；`compact()` 保持同步占位符。
   */
  summarizer?: ContextSummarizer;
}
