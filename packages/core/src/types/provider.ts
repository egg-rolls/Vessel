/**
 * LLM Provider 类型定义
 * @module @vessel/core/provider
 */

// biome-ignore lint/style/useNamingConvention: LLM API protocol fields (OpenAI/Anthropic API)

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
}

/** 使用量 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
   * 流式增量回调。当 stream=true 且本字段存在时，Provider 在接收 LLM 流式响应时
   * 逐 chunk 调用；chat() 仍返回拼装好的完整 LLMResponse（ADR-007：流式=事件订阅，
   * 非独立方法）。非流式 Provider 忽略本字段即退化为整段返回。
   */
  on_chunk?: (chunk: StreamChunk) => void;
}

/** 流式 chunk：Provider 吐给 loop 的增量单元 */
export interface StreamChunk {
  /** chunk 类型 */
  type: 'text_delta' | 'tool_call_delta' | 'finish';
  /** text_delta：文本增量 */
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
}

/** LLM Provider 接口 */
export interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
}

/** Provider 工厂 */
export type ProviderFactory = (config: Record<string, unknown>) => LLMProvider;
