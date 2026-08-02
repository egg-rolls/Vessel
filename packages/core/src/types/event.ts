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

/** Run 开始事件 payload */
export interface RunStartedPayload {
  run_id: string;
  session_id?: string;
  input: string;
}

/** LLM 请求事件 payload */
export interface LlmRequestPayload {
  run_id: string;
  messages: unknown[];
  tools?: unknown[];
}

/** LLM 响应事件 payload */
export interface LlmResponsePayload {
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
export interface LlmStreamChunkPayload {
  run_id: string;
  chunk: StreamChunk;
}

/** 工具调用开始事件 payload */
export interface ToolCallStartedPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
}

/** 工具调用完成事件 payload */
export interface ToolCallCompletedPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  result: string;
  duration_ms: number;
}

/** 工具调用失败事件 payload */
export interface ToolCallFailedPayload {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  error: string;
  duration_ms: number;
}

/** Guardrail 阻止事件 payload */
export interface GuardrailBlockedPayload {
  run_id: string;
  guardrail_name: string;
  stage: string;
  reason: string;
}

/** Guardrail 修改事件 payload */
export interface GuardrailModifiedPayload {
  run_id: string;
  guardrail_name: string;
  stage: string;
  original: unknown;
  modified: unknown;
}

/** Run 完成事件 payload */
export interface RunCompletedPayload {
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
export interface RunFailedPayload {
  run_id: string;
  session_id?: string;
  error: string;
  duration_ms: number;
}

/** 错误事件 payload */
export interface ErrorPayload {
  run_id?: string;
  error: string;
  code?: string;
}

/** Run 事件 - discriminated union，TypeScript 可根据 type 自动 narrow data 类型 */
export type RunEvent =
  | { type: EventType.RunStarted; run_id: string; data: RunStartedPayload; ts: number }
  | { type: EventType.LlmRequest; run_id: string; data: LlmRequestPayload; ts: number }
  | { type: EventType.LlmResponse; run_id: string; data: LlmResponsePayload; ts: number }
  | { type: EventType.LlmStreamChunk; run_id: string; data: LlmStreamChunkPayload; ts: number }
  | { type: EventType.ToolCallStarted; run_id: string; data: ToolCallStartedPayload; ts: number }
  | { type: EventType.ToolCallCompleted; run_id: string; data: ToolCallCompletedPayload; ts: number }
  | { type: EventType.ToolCallFailed; run_id: string; data: ToolCallFailedPayload; ts: number }
  | { type: EventType.GuardrailBlocked; run_id: string; data: GuardrailBlockedPayload; ts: number }
  | { type: EventType.GuardrailModified; run_id: string; data: GuardrailModifiedPayload; ts: number }
  | { type: EventType.RunCompleted; run_id: string; data: RunCompletedPayload; ts: number }
  | { type: EventType.RunFailed; run_id: string; data: RunFailedPayload; ts: number }
  | { type: EventType.SessionCreated; run_id: string; data: Record<string, never>; ts: number }
  | { type: EventType.SessionLoaded; run_id: string; data: Record<string, never>; ts: number }
  | { type: EventType.Error; run_id: string; data: ErrorPayload; ts: number };

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
}
