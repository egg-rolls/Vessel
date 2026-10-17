/**
 * Tool 类型定义
 * @module @vessel/core/tools
 */

import type { EventStream } from './event.js';
import type { Message } from './provider.js';

/** 工具上下文 */
export interface ToolContext {
  session_id?: string;
  run_id: string;
  messages: Message[];
  /** 事件流（ADR-026/027：工具可发事件、等事件，实现交互暂停） */
  events: EventStream;
  /** 当前 run 的 AbortSignal（F10）；工具可用它响应取消 */
  signal?: AbortSignal;
}

/** 工具处理函数 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

/**
 * 工具定义（ADR-026：自描述对象——权限判定下沉到工具节点）
 * 工具的唯一注册入口是 PluginHost（插件在 install 里 registerTool）。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** 超时毫秒数；缺省或 0 = 不限时 */
  timeout?: number;
  /** 执行时权限判定（allow/deny/ask）；缺省走 runtime 默认策略 */
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
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
