/**
 * 前端轻量事件类型声明。
 *
 * 复用 gateway 的 RunEvent / SessionInfo 结构（见
 * packages/core/src/types/event.ts 与 packages/core/src/types/session.ts），
 * 但不 import core 源码——前端自行声明一份最小契约。
 */

/** Run 事件（type 为开放字符串协议） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
}

/** LLM 流式 chunk（对应 core 的 StreamChunk） */
export interface StreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'finish';
  delta?: string;
  tool_call_index?: number;
  tool_call_id?: string;
  tool_call_name?: string;
  arguments_delta?: string;
  finish_reason?: string;
  usage?: Usage;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** LLM 工具 Schema（对应 core 的 ToolSchema，见 `llm.request.data.tools`） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 会话摘要（对应 /sessions 返回的 SessionInfo） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch?: string;
}
