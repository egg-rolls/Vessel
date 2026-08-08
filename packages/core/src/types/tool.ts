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
}

/** 工具处理函数 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

/**
 * 工具定义（ADR-026：自描述对象——权限/暂停/显示/条件启用下沉到工具节点）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  timeout?: number;
  default?: boolean; // true = 在 system prompt 中自动列出; false = 通过 search_assets 发现
  // ── 自描述字段（全可选，向后兼容）──
  /** 需要暂停等用户输入（工具用 ctx.events.waitFor 等回复事件） */
  interactive?: boolean;
  /** 执行时权限判定（allow/deny/ask） */
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
  /** 自定义显示数据（默认 TUI 模板渲染，工具可选声明渲染数据，与 ADR-021 调和） */
  render?(input: unknown): unknown;
  /** 条件启用 */
  isEnabled?(): boolean;
  /** 延迟加载（tool_reference，预留） */
  shouldDefer?: boolean;
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
