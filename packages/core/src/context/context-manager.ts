/**
 * ContextManager 实现
 * @module @vessel/core/context
 *
 * Auto Compact: add() 时如果 autoCompact=true 且 token 超阈值，自动压缩。
 * 优先使用 LLM 响应的真实 token 数，否则用字符估算。
 */

import type { ContextConfig, ContextManager } from '../types/context.js';
import type { Message } from '../types/provider.js';

export class MemoryContextManager implements ContextManager {
  private sessionMessages: Map<string, Message[]> = new Map();
  private currentSessionId = 'default';
  private config: ContextConfig;
  private realTokens = 0;

  constructor(config: ContextConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 4096,
      maxMessages: config.maxMessages ?? 100,
      autoCompact: config.autoCompact ?? true,
      compactThreshold: config.compactThreshold ?? 0.8,
      onCompact: config.onCompact,
    };
    this.sessionMessages.set(this.currentSessionId, []);
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
    if (!this.sessionMessages.has(sessionId)) {
      this.sessionMessages.set(sessionId, []);
    }
    this.realTokens = 0;
  }

  getSessionId(): string {
    return this.currentSessionId;
  }

  add(msg: Message): void {
    const msgs = this.sessionMessages.get(this.currentSessionId) || [];
    msgs.push(msg);
    this.sessionMessages.set(this.currentSessionId, msgs);

    if (this.config.autoCompact && this.shouldCompact()) {
      this.compact();
    }

    if (msgs.length > (this.config.maxMessages ?? 100)) {
      this.sessionMessages.set(
        this.currentSessionId,
        msgs.slice(-(this.config.maxMessages ?? 100)),
      );
    }
  }

  get messages(): Message[] {
    return [...(this.sessionMessages.get(this.currentSessionId) || [])];
  }

  /** Token 数：优先用 LLM 真实值，否则字符估算 */
  get tokenCount(): number {
    if (this.realTokens > 0) return this.realTokens;

    const msgs = this.sessionMessages.get(this.currentSessionId) || [];
    let count = 0;
    for (const m of msgs) {
      const total = m.content.length;
      const cjk = (m.content.match(/[一-鿿㐀-䶿]/g) || []).length;
      count += Math.ceil((total - cjk) * 0.25 + cjk * 0.5);
    }
    return count;
  }

  /** 用 LLM 返回的真实 token 数替代估算 */
  updateRealTokens(total: number): void {
    this.realTokens = total;
  }

  /**
   * 压缩上下文。保留 system + 最近 ~30% 消息，移除中间并注入摘要。
   * @returns 本次移除的消息数（0 = 未压缩）
   */
  compact(): number {
    const msgs = this.sessionMessages.get(this.currentSessionId) || [];
    if (msgs.length <= 2) return 0;

    const systemMsgs = msgs.filter((m) => m.role === 'system');
    const nonSystem = msgs.filter((m) => m.role !== 'system');

    const keep = Math.max(2, Math.floor(nonSystem.length * 0.3));
    if (nonSystem.length <= keep) return 0;

    const removed = nonSystem.length - keep;
    const summary: Message = {
      role: 'assistant',
      content: `[Auto Compact: ${removed} older messages summarized. Continuing...]`,
    };

    this.sessionMessages.set(this.currentSessionId, [
      ...systemMsgs,
      summary,
      ...nonSystem.slice(-keep),
    ]);

    this.config.onCompact?.(removed, this.messages.length);

    this.realTokens = 0;
    return removed;
  }

  clear(): void {
    this.sessionMessages.set(this.currentSessionId, []);
    this.realTokens = 0;
  }

  clearSession(sessionId: string): void {
    this.sessionMessages.set(sessionId, []);
  }

  deleteSession(sessionId: string): void {
    this.sessionMessages.delete(sessionId);
  }

  getSessionIds(): string[] {
    return Array.from(this.sessionMessages.keys());
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMessages.has(sessionId);
  }

  private shouldCompact(): boolean {
    const threshold = this.config.compactThreshold ?? 0.8;
    const max = this.config.maxTokens ?? 4096;
    return this.tokenCount > max * threshold;
  }
}

export type { ContextConfig, ContextManager };
