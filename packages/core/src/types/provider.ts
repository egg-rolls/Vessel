/**
 * LLM Provider 类型定义
 * @module @vessel/core/provider
 */

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

/** 工具调用 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具 Schema */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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
  session_id?: string;  // 会话 ID，用于 Provider 状态管理
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
