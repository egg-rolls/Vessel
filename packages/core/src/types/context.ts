/**
 * Context 类型定义
 * @module @vessel-agent/core/context
 */

import type { Message } from './provider.js';

/** 摘要器选项（0.6.1 E3；0.34 S4 / C3 additive） */
export interface ContextSummaryOptions {
  /** 摘要目标 token 预算（取 ContextConfig.maxTokens） */
  maxTokens: number;
  /**
   * 当前窗口已有压缩摘要（最后一条 `compaction_summary` system 消息的 content）。
   * 摘要器应在其基础上合并更新，而不是只概括本次移除的消息；缺省表示首次压缩。
   */
  previousSummary?: string;
  /** 本次将被摘要替代的消息估算 token（`estimateMessagesTokens(toSummarize)`），驱动输出预算 */
  removedTokens?: number;
  /**
   * 手动 / overflow 压缩为 true，自动阈值为 false。
   * 熔断器据此绕过冷却并先清零失败计数（R7）。
   */
  force?: boolean;
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

/**
 * 一次压缩的结果报告（0.34 S1 / C2）。
 *
 * 只服务事件写入与 runtime 判重：不持久化，也不参与投影。
 */
export interface CompactionReport {
  /** 单调递增；runtime 据此发现 `add()` 内同步压缩 */
  id: number;
  /** 本次移除的消息数 */
  removed: number;
  /** 本次被替换为占位的 tool_call_id（空数组 = 没有可清空的工具结果） */
  cleared_tool_call_ids: string[];
  /** 摘要由占位符代替（失败/超时/空/无 summarizer） */
  degraded: boolean;
}

/**
 * 库未配置 `compactThreshold` 时的兜底阈值（0.34 S2）。
 *
 * 应用层唯一来源是 `config.context.compactThreshold`（默认同值）；core 只在
 * 未注入配置时使用本常量，不参与应用层判定。
 */
export const DEFAULT_COMPACT_THRESHOLD = 0.85;

/**
 * 上下文真实用量锚点（0.52 C，additive）。
 *
 * `ratio = prompt_tokens / request_estimate`：某一轮 provider 响应上报的真实
 * prompt 用量 ÷ **同一请求**的本地估算（未校正）。`realTokens` 只对某一次
 * provider 请求有效，重启 / 新进程第一轮 / 压缩后都会归零；归零期间 `tokenCount`
 * 用这个比值把本地估算校正到 provider 的口径，否则长会话会莫名从 80% 掉回 51%
 * （本地估算对 CJK / reasoning / 工具参数偏乐观）。
 */
export interface ContextAnchor {
  /** prompt_tokens ÷ 同一请求的本地估算；记录时已 clamp 到 [0.5, 3] */
  ratio: number;
  /** provider 上报的真实 prompt 用量（分子，便于回溯偏差来源） */
  prompt_tokens: number;
  /** 同一请求的本地估算（分母，未校正） */
  request_estimate: number;
  /** 记录时的模型；换模型 tokenizer 就不同，读方只在同一 model 下才应用 */
  model?: string;
  /** 记录时刻（epoch ms） */
  at: number;
}

/** 环境快照（上下文卡）的发布指纹：跨进程重启去重（0.52，additive） */
export interface PromptContextFingerprint {
  /** 系统提示词 + 自述卡的全文 hash */
  hash: string;
  /** 模型名：换模型必须重发（tokenizer / 窗口都变了） */
  model: string;
  /** 工具个数：装/卸插件必须重发 */
  tools_count: number;
  /** 最后一次发布的时刻（epoch ms） */
  at: number;
}

/** 一次 Run 的上下文窗口（per Run，从 SessionEventLog 重建，不落库） */
export interface WorkingContext {
  add(msg: Message): void;
  readonly messages: Message[];
  /** @returns 本次移除的消息数（0 = 未压缩）；同步实现，无 summarizer 时用占位符 */
  compact(): number;
  /**
   * 0.6.1 E3：异步压缩。配置 summarizer 时产生真实摘要，
   * 否则回退到同步 compact() 的占位符。实现可选。
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
  /**
   * 0.28：自动压缩是否启用；实现能提供时 runtime 据此决定压力提示的上界。
   * 缺省（实现不提供）按「开启」处理，行为与 0.27 一致。
   */
  readonly autoCompact?: boolean;
  /**
   * 0.34 S2：自动压缩阈值。应用层由 config 注入；
   * 实现不提供时 runtime 用 `DEFAULT_COMPACT_THRESHOLD` 兜底。
   */
  readonly compactThreshold?: number;
  /**
   * 0.34 S1：最近一次成功压缩的报告（C2）。不持久化；runtime 比对 `id`
   * 判断这期间是否发生了（含 `add()` 内的同步压缩）。
   */
  readonly lastCompaction?: CompactionReport;
  setSessionId(sessionId: string): void;
  getSessionId(): string;
  /** 用 LLM 响应的真实 token 数替代估算（Auto Compact 使用） */
  updateRealTokens(total: number): void;
  /**
   * 0.52 C：注入按会话落盘的真实锚点（重启后 `realTokens` 为 0 时生效）。
   * `model` 是当前生效模型：与锚点记录的模型不同则不校正 —— tokenizer 不同，
   * 硬套比值比不校正更糟。实现可选。
   */
  setContextAnchor?(anchor: ContextAnchor | undefined, model?: string): void;
  /**
   * 0.52 C：把一次 provider 上报的 prompt 用量换算成锚点并生效。
   * 实现内部用**未校正的本地估算**做分母（不能用 `tokenCount`：它有真实值后
   * 已经等于真实口径，比值会塌成 1.0 而失去校正意义）。实现可选。
   */
  recordRealPromptTokens?(input: {
    promptTokens: number;
    model?: string;
  }): ContextAnchor | undefined;
  /** 0.52 C：当前生效的锚点；runtime 保存 SessionState 时取它落盘。实现可选。 */
  readonly contextAnchor?: ContextAnchor;
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
  /**
   * 0.53 主题1②：保住下来的工具结果原文体积占窗口预算的比例阈值。
   * 超过 ⇒ `shouldCompact()` 判定该压缩/开新段（默认 `TOOL_RESULT_VOLUME_THRESHOLD_RATIO`）。
   * 只是**多一个触发维度**，不放宽 token 主阈值，也不改清除集合的算法。
   */
  toolResultVolumeRatio?: number;
  /** 压缩完成回调（removedCount, remainingCount），供 TUI 显示提示 */
  onCompact?: (removed: number, remaining: number) => void;
  /**
   * 0.6.1 E3：真实摘要器。缺省时保留占位符摘要（向后兼容）。
   * 配置后由 `compactAsync()` / `autoCompactAsync()` 消费；`compact()` 保持同步占位符。
   */
  summarizer?: ContextSummarizer;
}
