/**
 * LLM Provider 类型定义
 * @module @vessel-agent/core/provider
 */

import type { ToolCall, ToolSchema } from './tool.js';

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 消息 */
export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * 思维链内容（OpenAI 兼容的 thinking 模式，如 DeepSeek）。
   * 只存在于 assistant 消息：Provider 返回后由 runtime 原样保存，
   * 下一次请求必须回传，否则 API 会拒绝（reasoning_content required）。
   * 不发送到 TUI / 事件流，避免泄漏思维链。
   */
  reasoning_content?: string;
  /**
   * 消息写入时间（Unix ms，0.6.1 P2）。可选：旧数据缺失时消费者降级。
   * runtime 在加入上下文时补齐；Provider 适配层忽略该字段。
   */
  timestamp?: number;
  /**
   * 压缩摘要标记：仅 core 内部用于识别摘要（role=system）。Provider 忽略该字段。
   */
  compaction_summary?: boolean;
}

/** 使用量 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Anthropic 显式提示词缓存：写入缓存的输入 token 数（其他 provider 可缺省） */
  cache_creation_input_tokens?: number;
  /** Anthropic 显式提示词缓存：从缓存读取的输入 token 数（其他 provider 可缺省） */
  cache_read_input_tokens?: number;
}

/** 聊天请求 */
export interface ChatRequest {
  messages: Message[];
  model: string;
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  session_id?: string; // 会话 ID，用于 Provider 状态管理
  /** AbortSignal——Provider 传给 fetch() 以支持流中断（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /**
   * 是否把思维链增量经 `on_chunk` 回调（`reasoning_delta`，0.11.1）。
   * 显式 opt-in；未设置时与 0.11.0 一致：只累积进 `response.reasoning_content`，
   * 不产生 reasoning chunk / 事件。
   */
  include_reasoning?: boolean;
  /**
   * 流式增量回调。当 stream=true 且本字段存在时，Provider 在接收 LLM 流式响应时
   * 逐 chunk 调用；chat() 仍返回拼装好的完整 LLMResponse（ADR-007：流式=事件订阅，
   * 非独立方法）。非流式 Provider 忽略本字段即退化为整段返回。
   */
  on_chunk?: (chunk: StreamChunk) => void;
}

/** 流式 chunk：Provider 吐给 loop 的增量单元 */
export interface StreamChunk {
  /** chunk 类型 */
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'finish';
  /** text_delta / reasoning_delta：增量文本 */
  delta?: string;
  /** tool_call_delta：第几个 tool_call（按 index 累积，对应 OpenAI delta.tool_calls[].index） */
  tool_call_index?: number;
  /** tool_call_delta：该 tool_call 首次出现时携带的 id */
  tool_call_id?: string;
  /** tool_call_delta：该 tool_call 首次出现时携带的 function name */
  tool_call_name?: string;
  /** tool_call_delta：function arguments 的部分 JSON 片段（需按 index 拼接） */
  arguments_delta?: string;
  /** finish：完成原因 */
  finish_reason?: FinishReason;
  /** finish：用量（流式 usage 仅在流末尾可得） */
  usage?: Usage;
}

/** 完成原因 */
export type FinishReason = 'stop' | 'tool_calls' | 'length';

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
  usage?: Usage;
  /** 思维链内容（thinking 模式）；存在时 runtime 写入 assistant 消息并在下一轮回传 */
  reasoning_content?: string;
}

/** LLM Provider 接口 */
export interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
}

/** Provider 工厂 */
export type ProviderFactory = (config: Record<string, unknown>) => LLMProvider;
