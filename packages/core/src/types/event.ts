/**
 * Event 类型定义
 * @module @vessel/core/events
 */

import type { StreamChunk } from './provider.js';

/** 核心事件名常量（ADR-027：事件名+payload 开放，核心事件保留常量保证拼写稳定） */
export const EventType = {
  RunStarted: 'run.started',
  LlmRequest: 'llm.request',
  LlmResponse: 'llm.response',
  LlmStreamChunk: 'llm.stream.chunk',
  ToolCallStarted: 'tool.call.started',
  ToolCallCompleted: 'tool.call.completed',
  ToolCallFailed: 'tool.call.failed',
  GuardrailBlocked: 'guardrail.blocked',
  GuardrailModified: 'guardrail.modified',
  RunCompleted: 'run.completed',
  RunFailed: 'run.failed',
  SessionCreated: 'session.created',
  SessionLoaded: 'session.loaded',
  Error: 'error',
} as const;

/** 核心事件名类型（值联合；RunEvent.type 已放宽为 string，扩展事件用任意字符串，无需改 core） */
export type EventType = (typeof EventType)[keyof typeof EventType];

/** 权限确认事件名（ADR-029：checkPermission 返回 'ask' 时，runtime 发请求事件、事件流等用户 allow/deny）
 *  沿用插件既有约定 `tool.permission.request` / `tool.permission.response`（见 plugins/* requestPermission），
 *  避免两套协议并存导致工具自带 checkPermission 的 30s 等待后再走 runtime 兜底。 */
export const PermissionEvent = {
  Requested: 'tool.permission.request',
  Decided: 'tool.permission.response',
} as const;

/** 基础事件 payload */
interface BaseEventPayload {
  [key: string]: unknown;
}

/** Run 开始事件 payload */
export interface RunStartedPayload extends BaseEventPayload {
  run_id: string;
  session_id?: string;
  input: string;
}

/** LLM 请求事件 payload */
export interface LlmRequestPayload extends BaseEventPayload {
  run_id: string;
  messages: unknown[];
  tools?: unknown[];
}

/** LLM 响应事件 payload */
export interface LlmResponsePayload extends BaseEventPayload {
  run_id: string;
  content?: string;
  tool_calls?: unknown[];
  finish_reason: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** LLM 流式 chunk 事件 payload（ADR-007：流式=事件订阅；ADR-016） */
export interface LlmStreamChunkPayload extends BaseEventPayload {
  run_id: string;
  chunk: StreamChunk;
}

/** 工具调用开始事件 payload */
export interface ToolCallStartedPayload extends BaseEventPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
}

/** 工具调用完成事件 payload */
export interface ToolCallCompletedPayload extends BaseEventPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  result: string;
  duration_ms: number;
}

/** 工具调用失败事件 payload */
export interface ToolCallFailedPayload extends BaseEventPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  error: string;
  duration_ms: number;
}

/** Guardrail 阻止事件 payload */
export interface GuardrailBlockedPayload extends BaseEventPayload {
  run_id: string;
  guardrail_name: string;
  stage: string;
  reason: string;
}

/** Guardrail 修改事件 payload */
export interface GuardrailModifiedPayload extends BaseEventPayload {
  run_id: string;
  guardrail_name: string;
  stage: string;
  original: unknown;
  modified: unknown;
}

/** Run 完成事件 payload */
export interface RunCompletedPayload extends BaseEventPayload {
  run_id: string;
  session_id?: string;
  output: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number;
  };
  duration_ms: number;
  iterations: number;
}

/** Run 失败事件 payload */
export interface RunFailedPayload extends BaseEventPayload {
  run_id: string;
  session_id?: string;
  error: string;
  duration_ms: number;
}

/** 错误事件 payload */
export interface ErrorPayload extends BaseEventPayload {
  run_id?: string;
  error: string;
  code?: string;
}

/** 事件 payload 联合类型 */
export type EventPayload =
  | RunStartedPayload
  | LlmRequestPayload
  | LlmResponsePayload
  | LlmStreamChunkPayload
  | ToolCallStartedPayload
  | ToolCallCompletedPayload
  | ToolCallFailedPayload
  | GuardrailBlockedPayload
  | GuardrailModifiedPayload
  | RunCompletedPayload
  | RunFailedPayload
  | ErrorPayload
  | BaseEventPayload;

/** Run 事件（ADR-027：type 放宽为 string，插件可发布自定义事件名；核心事件名见 EventType 常量） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: EventPayload | Record<string, unknown>;
  ts: number;
}

/** 事件处理器 */
export type EventHandler = (event: RunEvent) => void | Promise<void>;

/** 取消订阅函数 */
export type Unsubscribe = () => void;

/** 事件流接口 */
export interface EventStream {
  subscribe(handler: EventHandler): Unsubscribe;
  publish(event: RunEvent): void;
  clear(): void;
  /** 获取事件历史（按 run_id 过滤，不传返回全部） */
  getHistory(runId?: string): RunEvent[];
  /**
   * 等待一次匹配事件（ADR-027）。工具用它实现交互暂停：发请求事件 → 等回复事件。
   * @param name 事件名
   * @param opts.requestId 匹配 payload 中的 requestId（防多实例串台）
   * @param opts.timeout 超时毫秒（默认 30000），超时 reject
   * @returns 匹配事件的 data
   */
  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown>;
}
