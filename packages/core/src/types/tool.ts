/**
 * Tool 类型定义
 * @module @vessel/core/tools
 */

import type { Message } from './provider.js';

/** 工具上下文 */
export interface ToolContext {
  session_id?: string;
  run_id: string;
  messages: Message[];
}

/** 工具处理函数 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  timeout?: number;
  default?: boolean;  // true = 在 system prompt 中自动列出; false = 通过 search_assets 发现
}

/** 工具 Schema（用于 LLM） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具调用请求 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具调用结果 */
export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  error?: string;
}

/** 工具注册表接口 */
export interface ToolRegistry {
  register(def: ToolDefinition): void;
  invoke(call: ToolCall, ctx: ToolContext): Promise<string>;
  schemas(): ToolSchema[];
  get(name: string): ToolDefinition | undefined;
  has(name: string): boolean;
  list(): ToolDefinition[];
}
