/**
 * Event 类型定义
 * @module @vessel/core/events
 */

import type { StreamChunk } from './provider.js';

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
  | RunCompletedPayload
  | RunFailedPayload
  | ErrorPayload
  | BaseEventPayload;

/** Run 事件（ADR-030：type 为开放字符串协议，无事件名常量；核心事件名见 docs/ADR.md ADR-027） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: EventPayload | Record<string, unknown>;
  ts: number;
  /**
   * 0.5：同一 run 内单调递增序号。实时内存事件允许缺省；
   * trace 落盘时由 `FileTraceRecorder` 分配并持久化。
   */
  seq?: number;
  /** 0.5：所属 tenant；缺省视为 `default` */
  tenant_id?: string;
  /**
   * 0.6：事件来源节点。本节点直接产生的事件可不填；跨节点回灌 / 扇出时
   * 由传输或 gateway 边界填充。消费方按 `(node_id, run_id)` 理解 seq，
   * 按 `(node_id, seq)` 去重；没有全局序号。
   */
  node_id?: string;
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
