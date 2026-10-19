/**
 * ContextManager 实现
 * @module @vessel/core/context
 *
 * Auto Compact: add() 时如果 autoCompact=true 且 token 超阈值，自动压缩。
 * 优先使用 LLM 响应的真实 token 数，否则用字符估算。
 */

import type { ContextConfig, ContextManager } from '../types/context.js';
import type { Message } from '../types/provider.js';

/** 无 summarizer 时的占位摘要（保持 0.4/0.5 的可见行为） */
function placeholderSummary(removed: number): string {
  return `[Auto Compact: ${removed} older messages summarized. Continuing...]`;
}

interface CompactionPlan {
  /** 计划所属会话：summarizer await 期间可能切换会话，应用时必须回到原会话 */
  sessionId: string;
  /** 将被摘要替代的消息（对象引用，用于并发安全地移除） */
  toSummarize: Message[];
}

export class MemoryContextManager implements ContextManager {
  private sessionMessages: Map<string, Message[]> = new Map();
  private currentSessionId = 'default';
  private config: ContextConfig;
  private realTokens = 0;
  /** 异步压缩去重：同一会话同一时刻只跑一次 summarizer */
  private compaction?: { sessionId: string; promise: Promise<number> };

  constructor(config: ContextConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 4096,
      maxMessages: config.maxMessages ?? 100,
      autoCompact: config.autoCompact ?? true,
      compactThreshold: config.compactThreshold ?? 0.8,
      onCompact: config.onCompact,
      summarizer: config.summarizer,
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

    // 配置真实 summarizer 时不在 add() 里同步压缩（不能 await）：
    // 由 runtime 在请求组装前调用 autoCompactAsync() 产生真实摘要。
    // 未配置时保持同步占位符压缩，向后兼容。
    if (this.config.autoCompact && this.shouldCompact() && !this.config.summarizer) {
      this.compact();
    }

    // compact 会替换 sessionMessages 里的数组；必须重新读取，否则会把压缩结果
    // 用 compact 前的旧数组覆盖掉（长会话 summary 丢失 + 反复 compact）。
    const current = this.sessionMessages.get(this.currentSessionId) ?? [];
    const maxMessages = this.config.maxMessages ?? 100;
    if (current.length > maxMessages) {
      this.sessionMessages.set(this.currentSessionId, current.slice(-maxMessages));
      this.realTokens = 0;
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
    const plan = this.planCompaction();
    if (!plan) return 0;

    this.applyCompaction(plan, placeholderSummary(plan.toSummarize.length));
    this.realTokens = 0;
    return plan.toSummarize.length;
  }

  /**
   * 0.6.1 E3：异步压缩。有 summarizer 时等待真实摘要；失败或空结果回退占位符。
   * 并发调用共享同一次压缩，避免重复摘要。
   */
  async compactAsync(): Promise<number> {
    const sessionId = this.currentSessionId;
    const inFlight = this.compaction;
    if (inFlight?.sessionId === sessionId) return inFlight.promise;

    const plan = this.planCompaction();
    if (!plan) return 0;

    const removed = plan.toSummarize.length;
    const task = (async () => {
      let summary = '';
      if (this.config.summarizer) {
        try {
          summary = await this.config.summarizer(plan.toSummarize, {
            maxTokens: this.config.maxTokens ?? 4096,
          });
        } catch {
          // 摘要失败不应中断 run：退回占位符。
          summary = '';
        }
      }
      const text = summary.trim() ? summary : placeholderSummary(removed);
      this.applyCompaction(plan, text);
      if (this.currentSessionId === plan.sessionId) this.realTokens = 0;
      return removed;
    })();

    const entry = { sessionId, promise: task };
    this.compaction = entry;
    try {
      return await task;
    } finally {
      if (this.compaction === entry) this.compaction = undefined;
    }
  }

  /**
   * 0.6.1 E3：按阈值自动压缩。`autoCompact: false` 或未超阈值时返回 0。
   */
  async autoCompactAsync(): Promise<number> {
    if (!this.config.autoCompact || !this.shouldCompact()) return 0;
    return this.compactAsync();
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

  /** 计算本次压缩范围：保留 system + 最近 ~30% 非 system 消息 */
  private planCompaction(): CompactionPlan | null {
    const sessionId = this.currentSessionId;
    const msgs = this.sessionMessages.get(sessionId) || [];
    if (msgs.length <= 2) return null;

    const nonSystem = msgs.filter((m) => m.role !== 'system');
    const keepCount = Math.max(2, Math.floor(nonSystem.length * 0.3));
    if (nonSystem.length <= keepCount) return null;

    return {
      sessionId,
      toSummarize: nonSystem.slice(0, nonSystem.length - keepCount),
    };
  }

  /**
   * 应用压缩结果。按对象引用移除摘要范围内消息，因此 summarizer await 期间
   * 新加入的消息不会被丢弃；system 消息始终保留。
   */
  private applyCompaction(plan: CompactionPlan, summaryText: string): void {
    const summary: Message = { role: 'assistant', content: summaryText };
    const current = this.sessionMessages.get(plan.sessionId) ?? [];
    const removed = new Set(plan.toSummarize);
    const remaining = current.filter((m) => !removed.has(m));
    const systemMsgs = remaining.filter((m) => m.role === 'system');
    const others = remaining.filter((m) => m.role !== 'system');
    const next = [...systemMsgs, summary, ...others];

    this.sessionMessages.set(plan.sessionId, next);
    this.config.onCompact?.(plan.toSummarize.length, next.length);
  }

  private shouldCompact(): boolean {
    const threshold = this.config.compactThreshold ?? 0.8;
    const max = this.config.maxTokens ?? 4096;
    return this.tokenCount > max * threshold;
  }
}

export type { ContextConfig, ContextManager };
