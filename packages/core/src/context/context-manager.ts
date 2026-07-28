/**
 * ContextManager 实现
 * @module @vessel/core/context
 */

import type { ContextConfig, ContextManager } from '../types/context.js';
import type { Message } from '../types/provider.js';

/**
 * 内存上下文管理器实现
 * 支持按 session_id 保存和加载上下文
 */
export class MemoryContextManager implements ContextManager {
  private sessionMessages: Map<string, Message[]> = new Map(); // 按 session_id 存储消息
  private currentSessionId = 'default';
  private config: ContextConfig;

  constructor(config: ContextConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 4096,
      maxMessages: config.maxMessages ?? 100,
      autoCompact: config.autoCompact ?? false,
      compactThreshold: config.compactThreshold ?? 0.8,
    };
    // 初始化默认会话
    this.sessionMessages.set(this.currentSessionId, []);
  }

  /**
   * 设置当前会话 ID
   * @param sessionId 会话 ID
   */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
    // 如果会话不存在，初始化为空数组
    if (!this.sessionMessages.has(sessionId)) {
      this.sessionMessages.set(sessionId, []);
    }
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string {
    return this.currentSessionId;
  }

  /**
   * 添加消息到上下文
   * @param msg 消息
   */
  add(msg: Message): void {
    const messages = this.sessionMessages.get(this.currentSessionId) || [];
    messages.push(msg);
    this.sessionMessages.set(this.currentSessionId, messages);

    // 如果启用自动压缩且超过阈值，则压缩
    if (this.config.autoCompact && this.shouldCompact()) {
      this.compact();
    }

    // 如果超过最大消息数，移除最旧的消息
    if (messages.length > (this.config.maxMessages ?? 100)) {
      const trimmedMessages = messages.slice(-(this.config.maxMessages ?? 100));
      this.sessionMessages.set(this.currentSessionId, trimmedMessages);
    }
  }

  /**
   * 获取所有消息
   */
  get messages(): Message[] {
    return [...(this.sessionMessages.get(this.currentSessionId) || [])];
  }

  /**
   * 获取估算的 token 数量
   * 简单估算：每个字符约 0.25 个 token（英文），中文约 0.5 个 token
   */
  get tokenCount(): number {
    const messages = this.sessionMessages.get(this.currentSessionId) || [];
    let count = 0;
    for (const msg of messages) {
      // 简单估算
      const charCount = msg.content.length;
      // 中文字符占比估算
      const chineseChars = (msg.content.match(/[\u4e00-\u9fff]/g) || []).length;
      const englishChars = charCount - chineseChars;
      count += Math.ceil(englishChars * 0.25 + chineseChars * 0.5);
    }
    return count;
  }

  /**
   * 压缩上下文
   * 保留系统消息和最近的消息，移除中间的消息
   */
  compact(): void {
    const messages = this.sessionMessages.get(this.currentSessionId) || [];
    if (messages.length <= 2) {
      return;
    }

    // 保留系统消息（如果有）
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    // 保留最近的消息
    const keepCount = Math.max(2, Math.floor(nonSystemMessages.length * 0.3));
    const recentMessages = nonSystemMessages.slice(-keepCount);

    // 创建摘要消息（如果压缩了内容）
    if (nonSystemMessages.length > keepCount) {
      const removedCount = nonSystemMessages.length - keepCount;
      const summaryMessage: Message = {
        role: 'assistant',
        content: `[Context compacted: ${removedCount} messages removed to save space]`,
      };
      this.sessionMessages.set(this.currentSessionId, [
        ...systemMessages,
        summaryMessage,
        ...recentMessages,
      ]);
    }
  }

  /**
   * 清空当前会话上下文
   */
  clear(): void {
    this.sessionMessages.set(this.currentSessionId, []);
  }

  /**
   * 清空指定会话上下文
   * @param sessionId 会话 ID
   */
  clearSession(sessionId: string): void {
    this.sessionMessages.set(sessionId, []);
  }

  /**
   * 删除指定会话
   * @param sessionId 会话 ID
   */
  deleteSession(sessionId: string): void {
    this.sessionMessages.delete(sessionId);
  }

  /**
   * 获取所有会话 ID
   */
  getSessionIds(): string[] {
    return Array.from(this.sessionMessages.keys());
  }

  /**
   * 检查会话是否存在
   * @param sessionId 会话 ID
   */
  hasSession(sessionId: string): boolean {
    return this.sessionMessages.has(sessionId);
  }

  /**
   * 检查是否应该压缩
   */
  private shouldCompact(): boolean {
    const threshold = this.config.compactThreshold ?? 0.8;
    const maxTokens = this.config.maxTokens ?? 4096;
    return this.tokenCount > maxTokens * threshold;
  }
}

export type { ContextConfig, ContextManager };
