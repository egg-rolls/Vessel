/**
 * Tool 类型定义
 * @module @vessel-agent/core/tools
 */

import type { EventStream } from './event.js';
import type { Message } from './provider.js';

/** 工具上下文 */
export interface ToolContext {
  session_id?: string;
  run_id: string;
  /**
   * 当前工具调用 ID（0.13，DECISION-024 §2.1）：与 `tool.call.started/completed`
   * 的 `tool_call_id` 对齐，供权限请求等交互事件关联。
   */
  tool_call_id?: string;
  messages: Message[];
  /** 事件流（ADR-026/027：工具可发事件、等事件，实现交互暂停） */
  events: EventStream;
  /** 当前 run 的 AbortSignal（F10）；工具可用它响应取消 */
  signal?: AbortSignal;
  /**
   * 权限请求来源（0.13）：管道默认 `runtime`；workflow / host 装配方可显式覆盖。
   * 仅用于事件关联，不参与权限判定。
   */
  source?: 'runtime' | 'workflow' | 'host';
}

/** 工具处理函数 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

/**
 * 工具展示元数据（0.14.1，additive，可序列化）。
 *
 * 仅供 Web/TUI 在通用回退之上做增强显示；不进入 LLM schema，
 * 也不参与权限 / 执行判定。
 */
export interface ToolDisplay {
  /** 人类可读短标签（例如 “Run tests”）；缺省由调用方回退到工具名 */
  label?: string;
  /** 展示分类；未知值由调用方按 `generic` 处理 */
  kind?: 'command' | 'file' | 'search' | 'generic';
}

/**
 * 工具定义（ADR-026：自描述对象——权限判定下沉到工具节点）
 * 工具的唯一注册入口是 PluginHost（插件在 install 里 registerTool）。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** 0.14.1：可选展示元数据；不影响执行与 LLM schema */
  display?: ToolDisplay;
  /** 超时毫秒数；缺省或 0 = 不限时 */
  timeout?: number;
  /**
   * 只读、无共享副作用：同一响应内连续的 concurrencySafe 调用会并批发车（0.6.1 P1）。
   * 缺省 false（串行）。有写副作用或依赖执行顺序的工具不要开启。
   */
  concurrencySafe?: boolean;
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
