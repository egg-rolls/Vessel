/**
 * Event 类型定义
 * @module @vessel/core/events
 */

import type { StreamChunk } from './provider.js';

/** 事件类型枚举 */
export enum EventType {
  RunStarted = 'run.started',
  LlmRequest = 'llm.request',
  LlmResponse = 'llm.response',
  LlmStreamChunk = 'llm.stream.chunk',
  ToolCallStarted = 'tool.call.started',
  ToolCallCompleted = 'tool.call.completed',
  ToolCallFailed = 'tool.call.failed',
  GuardrailBlocked = 'guardrail.blocked',
  GuardrailModified = 'guardrail.modified',
  RunCompleted = 'run.completed',
  RunFailed = 'run.failed',
  SessionCreated = 'session.created',
  SessionLoaded = 'session.loaded',
  Error = 'error',
}

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

/** Run 事件 */
export interface RunEvent {
  type: EventType;
  run_id: string;
  data: EventPayload;
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
}
