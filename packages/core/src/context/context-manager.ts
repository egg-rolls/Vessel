/**
 * WorkingContext 实现
 * @module @vessel-agent/core/context
 *
 * Auto Compact: add() 时如果 autoCompact=true 且 token 超阈值，自动压缩。
 * 优先使用 LLM 响应的真实 token 数，否则用字符估算。
 *
 * 0.10 R1-10：消息条数只是安全上限，不再是硬截断。超限时先摘要、再移除旧消息，
 * system 消息永不丢；token 估算统一由本模块导出，供 harness 复用。
 */

import {
  type CompactionReport,
  type ContextConfig,
  type ContextSummarizer,
  DEFAULT_COMPACT_THRESHOLD,
  type WorkingContext,
} from '../types/context.js';
import type { Message } from '../types/provider.js';
import { formatClearedToolResult, isClearedToolResult } from './cleared-tool-result.js';

/** 无 summarizer 时的占位摘要（保持 0.4/0.5 的可见行为） */
function placeholderSummary(removed: number): string {
  return `[Auto Compact: ${removed} older messages summarized. Continuing...]`;
}

/**
 * 压缩时保留原文的最近工具结果预算（R5，0.34 S1）。
 *
 * 从尾部累计 tool 结果的估算 token，保留到不超过 `maxTokens × 5%`：
 * 至少保留 1 条（最新结果通常仍被本轮引用），最多 10 条（一次 assistant
 * 轮次的并行调用上限）。属于压缩策略常量，按契约不新增配置键。
 */
const KEEP_RECENT_TOKEN_RATIO = 0.05;
const KEEP_RECENT_MAX = 10;

/**
 * 字符级 token 估算（ASCII 0.25 / CJK 0.5 token 每字符）。
 * 与 0.4 起的口径一致；TUI `/context` 应改用本函数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 按 UTF-16 码元扫，不逐字符建字符串、不跑正则：实测 1.36M 字符
  // 正则版 26–35ms → 码元版 1.5–2.7ms（同一份文本、同一结果）。
  // 取舍：代理对（emoji 等）按 2 个码元计，估算略偏大 —— 对 BPE 而言反而更接近实际。
  let cjk = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // U+4E00–U+9FFF（CJK 统一表意）+ U+3400–U+4DBF（扩展 A）
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1;
  }
  return Math.ceil((text.length - cjk) * 0.25 + cjk * 0.5);
}

/**
 * 单条消息的 token 估算：content + reasoning_content + name +
 * 所有 tool_calls 的函数名与 arguments。
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = estimateTokens(message.content ?? '');
  if (message.reasoning_content) tokens += estimateTokens(message.reasoning_content);
  if (message.name) tokens += estimateTokens(message.name);
  for (const call of message.tool_calls ?? []) {
    tokens += estimateTokens(call.function?.name ?? '');
    tokens += estimateTokens(call.function?.arguments ?? '');
  }
  return tokens;
}

/** 消息数组的 token 估算（与 estimateMessageTokens 同源） */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

interface CompactionPlan {
  /** 计划所属会话：summarizer await 期间可能切换会话，应用时必须回到原会话 */
  sessionId: string;
  /** 将被摘要替代的消息（对象引用，用于并发安全地移除） */
  toSummarize: Message[];
}

/** 消息条数安全上限：显式 `maxMessages` 优先；否则按 token 预算推导 */
function messageCapFor(config: { maxTokens?: number; maxMessages?: number }): number {
  const configured = config.maxMessages;
  if (configured !== undefined && configured > 0) return configured;
  const maxTokens = config.maxTokens ?? 1_000_000;
  return Math.max(100, Math.floor(maxTokens / 100));
}

/**
 * 纯函数版压缩边界计算：`compactMessagesForSeed` 与 `MemoryWorkingContext` 共用。
 * 不读实例状态，返回的 `toSummarize` 是传入消息数组的对象引用。
 */
function planCompactionForMessages(
  msgs: readonly Message[],
  config: { maxTokens?: number; maxMessages?: number },
  force: boolean,
): { toSummarize: Message[] } | null {
  const nonSystem = msgs.filter((m) => m.role !== 'system');
  // 非 system 少于 3 条时没有可摘要消息（至少保留 2 条）。
  if (nonSystem.length < 3) return null;

  const budget = (config.maxTokens ?? 1_000_000) * 0.3;
  let keepFromByTokens = nonSystem.length - 1;
  let keptTokens = 0;
  let kept = 0;
  for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
    const message = nonSystem[i];
    if (!message) break;
    const cost = estimateMessageTokens(message);
    // 超出预算即停止；最新 2 条无论如何保留。
    if (kept >= 2 && keptTokens + cost > budget) break;
    keptTokens += cost;
    kept += 1;
    keepFromByTokens = i;
  }

  // 压缩后 system 条数 = systemCount（旧摘要被新摘要替换，净数不变）+ 1 条新摘要。
  const systemCount = msgs.filter((m) => m.role === 'system').length;
  const maxKept = Math.max(2, messageCapFor(config) - systemCount - 1);
  const keepFromByCap = nonSystem.length - Math.min(nonSystem.length, maxKept);
  // 任一上限超限都要摘要：取更靠后的边界（保留更少），但不低于 2 条。
  let keepFrom = Math.min(Math.max(keepFromByTokens, keepFromByCap), nonSystem.length - 2);

  // 手动 compact / overflow 重试强制推进：即使全部能装下，也至少摘要到只剩 2 条。
  // autoCompact 传 false，避免在阈值未触发时无谓压缩。
  if (force && keepFrom === 0) keepFrom = nonSystem.length - 2;

  // 孤立 tool 消息会因缺少对应的 assistant(tool_calls) 被 provider 拒绝，
  // 把边界回退到该 tool 的 assistant，直到边界不再是 tool。
  // 配对完整性优先于条数上限，回退后保留数可能略超 messageCap。
  while (keepFrom > 0 && nonSystem[keepFrom]?.role === 'tool') {
    const toolCallId = nonSystem[keepFrom]?.tool_call_id;
    let ownerIndex = -1;
    for (let i = keepFrom - 1; i >= 0; i -= 1) {
      const candidate = nonSystem[i];
      if (
        candidate?.role === 'assistant' &&
        (candidate.tool_calls ?? []).some((call) => call.id === toolCallId)
      ) {
        ownerIndex = i;
        break;
      }
    }
    // 找不到 owner 说明历史本身不完整，继续前移也无法配对。
    if (ownerIndex < 0) break;
    keepFrom = ownerIndex;
  }

  if (keepFrom === 0) return null;
  return { toSummarize: nonSystem.slice(0, keepFrom) };
}

/** 纯函数版压缩应用：system 保留 + 新摘要替掉旧摘要 + 其余消息保持原顺序。 */
function applyCompactionToMessages(
  messages: readonly Message[],
  toSummarize: readonly Message[],
  summaryText: string,
): Message[] {
  const summary: Message = { role: 'system', content: summaryText, compaction_summary: true };
  const removed = new Set(toSummarize);
  // 旧摘要一并移除，保证任意时刻最多一条摘要。
  const remaining = messages.filter((m) => !removed.has(m) && !m.compaction_summary);
  const systemMsgs = remaining.filter((m) => m.role === 'system');
  const others = remaining.filter((m) => m.role !== 'system');
  return [...systemMsgs, summary, ...others];
}

/**
 * 清空时保留原文的最近工具结果条数（R5）：从尾部累计估算 token，
 * 保留到累计 ≤ `maxTokens × 5%`，至少 1 条、最多 10 条。
 */
function retainedToolResultCount(messages: readonly Message[], maxTokens: number): number {
  const budget = maxTokens * KEEP_RECENT_TOKEN_RATIO;
  let kept = 0;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0 && kept < KEEP_RECENT_MAX; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'tool') continue;
    const cost = estimateMessageTokens(message);
    // 最新 1 条无论如何保留；之后超出预算即停止。
    if (kept > 0 && tokens + cost > budget) break;
    tokens += cost;
    kept += 1;
  }
  return kept;
}

/**
 * 本次窗口里「会被换成占位」的旧工具结果（纯函数，**不改任何消息**）。
 *
 * 保留最近结果按 token 预算自适应（R5）：清空而不是删除 —— tool 消息与 assistant 的
 * `tool_calls` 按 `tool_call_id` 配对，删除任一侧都会让 provider 拒绝请求。
 *
 * 0.52 起它只负责**算**：真正替换发生在请求构建层（`withClearedToolResults`）。
 * 分开的理由是不变量「落盘的 message 只能 pop 或 append」：在压缩里就地改正文等于
 * 在磁盘上重写历史，用户回看旧消息时看到的就不是当时那份了。
 */
export function planClearedToolResults(
  messages: readonly Message[],
  maxTokens: number,
): string[] {
  const keep = retainedToolResultCount(messages, maxTokens);
  let skipped = 0;
  const cleared: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'tool') continue;
    if (skipped < keep) {
      skipped += 1;
      continue;
    }
    // 空内容本来就无需回收；已是占位文本则保持幂等。
    if (!message.content || isClearedToolResult(message.content)) continue;
    if (message.tool_call_id !== undefined) cleared.push(message.tool_call_id);
  }
  return cleared.reverse();
}

/**
 * 请求级视图：把超出保留预算的旧工具结果换成占位文本，**返回新数组**。
 *
 * 只有被替换的那几条消息是新对象（`{...message, content}`），其余原样透传 ——
 * 调用方（`ExecutionUnit.buildRequestMessages`）据此做到「发给 provider 的请求省 token，
 * 落盘的历史一个字不改」。这是本不变量在 core 里唯一允许的「视图层改写」。
 */
export function withClearedToolResults(
  messages: readonly Message[],
  maxTokens: number,
): Message[] {
  const cleared = planClearedToolResults(messages, maxTokens);
  if (cleared.length === 0) return [...messages];
  const ids = new Set(cleared);
  return messages.map((message) =>
    message.role === 'tool' &&
    typeof message.tool_call_id === 'string' &&
    ids.has(message.tool_call_id)
      ? {
          ...message,
          content: formatClearedToolResult(messages, message.tool_call_id, message.content),
        }
      : message,
  );
}

/**
 * 就地清空（**只给私有副本用**：fork 的 seed 会在自己那份拷贝上压缩）。
 *
 * 历史消息一律走 `withClearedToolResults`；这条路径之所以还能就地改，是因为它操作的
 * `copy` 从没落过盘 —— 改的是「新会话的出生内容」，不是已落盘历史。
 */
function clearOldToolResultsIn(messages: readonly Message[], maxTokens: number): string[] {
  const cleared = planClearedToolResults(messages, maxTokens);
  const ids = new Set(cleared);
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    if (!ids.has(message.tool_call_id)) continue;
    message.content = formatClearedToolResult(messages, message.tool_call_id, message.content);
  }
  return cleared;
}

/**
 * 当前窗口最近一条压缩摘要（C3 `previousSummary`）。
 *
 * 摘要器据此在原摘要上合并，而不是每次只概括本次移除的消息；没有旧摘要
 * （首次压缩）时返回 undefined。
 */
function lastSummaryContent(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'system' && message.compaction_summary === true) {
      return message.content;
    }
  }
  return undefined;
}

/** 深拷贝一条消息，避免压缩改动父会话的对象引用。 */
function cloneMessage(message: Message): Message {
  return {
    ...message,
    ...(message.tool_calls !== undefined
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            ...(call.function !== undefined ? { function: { ...call.function } } : {}),
          })),
        }
      : {}),
  };
}

/** 把一份消息数组压缩成新 Session 的种子（create seed）；父数组/消息不被修改。 */
export async function compactMessagesForSeed(
  messages: Message[],
  opts: {
    summarizer?: ContextSummarizer;
    maxTokens?: number;
  } = {},
): Promise<Message[]> {
  const maxTokens = opts.maxTokens ?? 1_000_000;
  // 与父会话完全隔离：后续清空旧工具结果 / 摘要都只动副本。
  const copy = messages.map(cloneMessage);
  const plan = planCompactionForMessages(copy, { maxTokens }, true);
  if (!plan) return copy;

  // 摘要输入按原始内容计量：清空旧工具结果之前取旧摘要与移除量。
  const previousSummary = lastSummaryContent(copy);
  const removedTokens = estimateMessagesTokens(plan.toSummarize);
  clearOldToolResultsIn(copy, maxTokens);
  let summary = '';
  if (opts.summarizer) {
    try {
      summary = await opts.summarizer(plan.toSummarize, {
        maxTokens,
        previousSummary,
        removedTokens,
        // compactFork 是显式 fork 操作，按手动压缩处理。
        force: true,
      });
    } catch {
      // 摘要失败不阻断 compactFork：退回占位符。
      summary = '';
    }
  }
  const text = summary.trim() ? summary : placeholderSummary(plan.toSummarize.length);
  return applyCompactionToMessages(copy, plan.toSummarize, text);
}

export class MemoryWorkingContext implements WorkingContext {
  private sessionMessages: Map<string, Message[]> = new Map();
  /** 估算 token 增量缓存（按 session）：避免 `tokenCount` 每次重扫整段历史。 */
  private estimatedTokens: Map<string, number> = new Map();
  private currentSessionId = 'default';
  private config: ContextConfig;
  private realTokens = 0;
  /** 异步压缩去重：同一会话同一时刻只跑一次 summarizer */
  private compaction?: { sessionId: string; promise: Promise<number> };
  /** 压缩报告序号：单调递增，runtime 据此发现这期间发生了压缩（C2） */
  private compactionSeq = 0;
  private compactionReport?: CompactionReport;

  constructor(config: ContextConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 1_000_000,
      // 未显式配置时按 token 预算推导安全上限（见 messageCap）。
      maxMessages: config.maxMessages,
      autoCompact: config.autoCompact ?? true,
      compactThreshold: config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
      onCompact: config.onCompact,
      summarizer: config.summarizer,
    };
    this.sessionMessages.set(this.currentSessionId, []);
  }

  setSessionId(sessionId: string): void {
    // 跨会话切换时丢弃上一会话的真实锚点：realTokens 属于某个 provider 请求的
    // 历史，另一个会话不能复用；同值重复设置不重置（runtime 每轮会调用一次）。
    if (sessionId !== this.currentSessionId) {
      this.realTokens = 0;
    }
    this.currentSessionId = sessionId;
    if (!this.sessionMessages.has(sessionId)) {
      this.sessionMessages.set(sessionId, []);
    }
  }

  getSessionId(): string {
    return this.currentSessionId;
  }

  /** 0.34 S2：自动压缩阈值；未由应用层注入时用库兜底值。 */
  get compactThreshold(): number {
    return this.config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  }

  add(msg: Message): void {
    const msgs = this.sessionMessages.get(this.currentSessionId) || [];
    msgs.push(msg);
    this.sessionMessages.set(this.currentSessionId, msgs);

    // 真实锚点 + 尾部增量：realTokens 来自上一次 provider 响应的真实用量；
    // 响应之后新增的消息（本轮追加、工具结果）用估算补齐，下一次响应再校正。
    // 必须在同步压缩之前累加——压缩会按现有逻辑把 realTokens 归零。
    // 估算缓存同时累加：没有真实锚点时 `tokenCount` 直接读它，避免 O(n²) 重扫。
    const delta = estimateMessageTokens(msg);
    this.estimatedTokens.set(
      this.currentSessionId,
      (this.estimatedTokens.get(this.currentSessionId) ?? 0) + delta,
    );
    if (this.realTokens > 0) {
      this.realTokens += delta;
    }

    // 配置真实 summarizer 时不在 add() 里同步压缩（不能 await）：
    // 由 runtime 在请求组装前调用 autoCompactAsync() 产生真实摘要。
    // 未配置时保持同步占位符压缩，向后兼容。
    // 消息条数安全上限不看 autoCompact：超限必须先摘要再移除，绝不静默截断。
    const overflow = this.isOverMessageCap();
    if (
      !this.config.summarizer &&
      (overflow || (this.config.autoCompact && this.shouldCompact()))
    ) {
      this.compact(false);
    }
  }

  get messages(): Message[] {
    return [...(this.sessionMessages.get(this.currentSessionId) || [])];
  }

  /** 0.34 S1：最近一次成功压缩的报告；未压缩过时缺省。 */
  get lastCompaction(): CompactionReport | undefined {
    return this.compactionReport;
  }

  /**
   * Token 数：优先用真实锚点（上一次 provider 响应 + 其后新增消息的估算增量），
   * 没有任何真实值时才用统一估算重扫全部消息（content / tool_calls / reasoning）。
   *
   * 无真实锚点时读 `estimatedTokens` 增量缓存：历史播种 / 逐条重放会对每条
   * 消息取一次 `tokenCount`，重扫整段历史会退化成 O(n²) 并阻塞事件循环
   * （长会话下一次 run 可卡住数十秒，租约因此过期）。
   */
  get tokenCount(): number {
    if (this.realTokens > 0) return this.realTokens;
    return this.estimatedTokens.get(this.currentSessionId) ?? 0;
  }

  /** 0.15：上下文 token 预算上限（快照 context_max 使用） */
  get maxTokens(): number {
    return this.config.maxTokens ?? 1_000_000;
  }

  /**
   * 0.28：自动压缩是否启用。只读暴露给 runtime：关闭时压力提示不能在上穿压缩
   * 阈值后静默（没有后续压缩会再把它降回来）。
   */
  get autoCompact(): boolean {
    return this.config.autoCompact !== false;
  }

  /**
   * 用 LLM 返回的真实 token 数绝对重置锚点（而非累加）；之后 add() 的新消息
   * 在锚点上做估算增量，直到下一次 provider 响应再次校正。
   */
  updateRealTokens(total: number): void {
    this.realTokens = total;
  }

  /**
   * 压缩上下文。保留 system + 最近的非 system 消息（token 预算 maxTokens × 0.3），
   * 移除中间并注入摘要。
   * @returns 本次移除的消息数（0 = 未压缩）
   */
  compact(force = true): number {
    const plan = this.planCompaction(force);
    if (!plan) return 0;

    // 先按原始内容决定压缩边界（阈值与 0.3 保留预算不变），再记「请求里会清空哪些」。
    // 注意：这里**不改**任何一个工具结果的正文 —— 占位发生在请求构建层。
    const cleared = this.plannedClearedToolResults(plan.sessionId);
    this.applyCompaction(plan, placeholderSummary(plan.toSummarize.length));
    this.realTokens = 0;
    this.recordCompaction(plan.toSummarize.length, cleared, true);
    return plan.toSummarize.length;
  }

  /**
   * 0.6.1 E3：异步压缩。有 summarizer 时等待真实摘要；失败或空结果回退占位符。
   * 并发调用共享同一次压缩，避免重复摘要。
   */
  async compactAsync(force = true): Promise<number> {
    const sessionId = this.currentSessionId;
    const inFlight = this.compaction;
    if (inFlight?.sessionId === sessionId) return inFlight.promise;

    const plan = this.planCompaction(force);
    if (!plan) return 0;

    // 摘要输入按原始内容计量：压缩边界与移除量都按原文取（占位不参与）。
    // 旧摘要取计划所属会话的当前窗口（await 期间可能切换会话）。
    const previousSummary = lastSummaryContent(this.sessionMessages.get(plan.sessionId) ?? []);
    const removedTokens = estimateMessagesTokens(plan.toSummarize);

    // 只记「请求里会清空哪些」，不动正文：落盘的历史消息必须是原文。
    const cleared = this.plannedClearedToolResults(plan.sessionId);

    const removed = plan.toSummarize.length;
    const task = (async () => {
      let summary = '';
      if (this.config.summarizer) {
        try {
          summary = await this.config.summarizer(plan.toSummarize, {
            maxTokens: this.config.maxTokens ?? 1_000_000,
            previousSummary,
            removedTokens,
            force,
          });
        } catch {
          // 摘要失败不应中断 run：退回占位符。
          summary = '';
        }
      }
      const text = summary.trim() ? summary : placeholderSummary(removed);
      this.applyCompaction(plan, text);
      if (this.currentSessionId === plan.sessionId) this.realTokens = 0;
      this.recordCompaction(removed, cleared, !summary.trim());
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
   * 0.10 R1-10：消息条数超安全上限时强制压缩（与 autoCompact 无关），
   * 保证 await 摘要完成之后才移除旧消息。
   */
  async autoCompactAsync(): Promise<number> {
    const overflow = this.isOverMessageCap();
    if (!overflow && (!this.config.autoCompact || !this.shouldCompact())) return 0;
    return this.compactAsync(false);
  }

  clear(): void {
    this.sessionMessages.set(this.currentSessionId, []);
    this.estimatedTokens.set(this.currentSessionId, 0);
    this.realTokens = 0;
  }

  clearSession(sessionId: string): void {
    this.sessionMessages.set(sessionId, []);
    this.estimatedTokens.set(sessionId, 0);
    // 清空当前会话后旧锚点已不代表其内容，必须归零；其他会话的锚点不受影响。
    if (sessionId === this.currentSessionId) this.realTokens = 0;
  }

  deleteSession(sessionId: string): void {
    this.sessionMessages.delete(sessionId);
    this.estimatedTokens.delete(sessionId);
  }

  getSessionIds(): string[] {
    return Array.from(this.sessionMessages.keys());
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMessages.has(sessionId);
  }

  /**
   * 计算本次压缩范围：system 始终保留；token 预算（maxTokens × 0.3）与
   * 条数上限共同决定边界，至少保留 2 条，且保留区不以孤立 tool 消息开头。
   */
  private planCompaction(force = false): CompactionPlan | null {
    const sessionId = this.currentSessionId;
    const msgs = this.sessionMessages.get(sessionId) || [];
    const plan = planCompactionForMessages(msgs, this.config, force);
    if (!plan) return null;
    return { sessionId, toSummarize: plan.toSummarize };
  }

  /**
   * 算一遍「哪些旧工具结果会在**请求里**被换成占位」，**不改任何消息**。
   *
   * 0.52 起这里只负责算：占位替换搬到请求构建层（`withClearedToolResults`），
   * `SessionState.messages` / 落盘 / `sessions.get` 读回来的永远是原文。原因是不变量
   * 「落盘的 message 只能 pop 或 append」—— 就地改内容等于在磁盘上重写历史。
   *
   * 算出来的集合仍写进 `message.compaction.cleared_tool_call_ids`：审计要知道「这一次
   * 之后，模型看到的是哪些工具结果的占位」。
   *
   * @returns 会被替换为占位的 tool_call_id（按消息顺序）
   */
  private plannedClearedToolResults(sessionId: string): string[] {
    return planClearedToolResults(
      this.sessionMessages.get(sessionId) ?? [],
      this.config.maxTokens ?? 1_000_000,
    );
  }

  /** 记录一次成功压缩（C2）：单调 id 供 runtime 判重，不持久化。 */
  private recordCompaction(removed: number, cleared: string[], degraded: boolean): void {
    this.compactionSeq += 1;
    this.compactionReport = {
      id: this.compactionSeq,
      removed,
      cleared_tool_call_ids: cleared,
      degraded,
    };
  }

  /**
   * 应用压缩结果。按对象引用移除摘要范围内消息，因此 summarizer await 期间
   * 新加入的消息不会被丢弃；system 消息始终保留。
   * 摘要写成 role=system + compaction_summary：thinking 模式下 assistant 消息
   * 必须带 reasoning_content，摘要没有 → 下一轮请求会被 Provider 拒绝。
   */
  private applyCompaction(plan: CompactionPlan, summaryText: string): void {
    const current = this.sessionMessages.get(plan.sessionId) ?? [];
    const next = applyCompactionToMessages(current, plan.toSummarize, summaryText);
    this.sessionMessages.set(plan.sessionId, next);
    // 移除 / 替换了消息：重建该会话的估算缓存。
    this.estimatedTokens.set(plan.sessionId, estimateMessagesTokens(next));
    this.config.onCompact?.(plan.toSummarize.length, next.length);
  }

  private shouldCompact(): boolean {
    const threshold = this.config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    const max = this.config.maxTokens ?? 1_000_000;
    // 0.10 R1-10：token 预算仍是主阈值（默认 0.85）；条数上限是兜底安全网。
    return this.tokenCount > max * threshold || this.isOverMessageCap();
  }

  /**
   * 消息条数安全上限。显式 `maxMessages` 优先；否则按 token 预算推导
   * （每 100 预算 token 允许 1 条，至少 100 条），只为兜住接近零 token 的消息，
   * 不应先于 token 阈值触发。
   */
  private get messageCap(): number {
    const configured = this.config.maxMessages;
    if (configured !== undefined && configured > 0) return configured;
    const maxTokens = this.config.maxTokens ?? 1_000_000;
    return Math.max(100, Math.floor(maxTokens / 100));
  }

  private isOverMessageCap(): boolean {
    const msgs = this.sessionMessages.get(this.currentSessionId) || [];
    return msgs.length > this.messageCap;
  }
}

export type { ContextConfig, WorkingContext };
