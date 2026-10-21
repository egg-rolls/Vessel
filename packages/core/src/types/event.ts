/**
 * Event 类型定义
 * @module @vessel-agent/core/events
 */

import type { ErrorEnvelope } from './error.js';
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
export interface ToolCallFailedPayload extends BaseEventPayload, Partial<ErrorEnvelope> {
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
export interface RunFailedPayload extends BaseEventPayload, Partial<ErrorEnvelope> {
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

/**
 * 会话事件日志写入输入（0.18，唯一真相源）。
 *
 * `seq` 由日志按 session 单调分配；调用方不传。事件名保持开放字符串。
 */
export interface SessionEventInput {
  session_id: string;
  run_id: string;
  type: string;
  ts: number;
  data: unknown;
}

/** 落盘后的会话事件记录（`events.ndjson` 单行） */
export interface SessionEventRecord extends SessionEventInput {
  v: 1;
  seq: number;
}

/** 会话索引的 additive 字段（`index.json`；只放元数据，不放 messages） */
export interface SessionIndexPatch {
  title?: string;
  preview?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  started_at?: number;
  updated_at?: number;
  event_count?: number;
  derived_upto_seq?: number;
}

/**
 * AgentRuntime 依赖的事件日志端口（0.18）。
 *
 * 只暴露 runtime 需要的部分；完整实现见 `@vessel-agent/core/session`
 * 的 `SessionEventLog`（read / iterate / 索引 / 删除）。
 */
export interface SessionEventLogPort {
  /** 追加一条事件；返回已分配 seq 的记录 */
  append(input: SessionEventInput): Promise<SessionEventRecord>;
  /** 读取事件（按 seq 升序）；`sinceSeq` 为排他游标 */
  read(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]>;
  /** 最近一次**已落盘**的 seq；未初始化/未写入返回 undefined */
  lastPersistedSeq(sessionId: string): number | undefined;
  /** 等待该 session（缺省全部）的写入队列排空 */
  flush(sessionId?: string): Promise<void>;
  /** 合并写会话索引（best-effort；实现可缺省） */
  updateIndex?(sessionId: string, patch: SessionIndexPatch): Promise<void>;
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
   * @param opts.timeout 超时毫秒。缺省 / `<= 0` 不设 timer（一直等到应答或 abort）；
   *   只有正数才超时 reject（0.13 Addendum A）
   * @param opts.signal 取消信号（0.13）：abort 时立即 reject 并清理等待资源，
   *   不复用超时错误；拒绝原因与 run 取消一致（`signal.reason` 或 AbortError）
   * @returns 匹配事件的 data
   */
  waitFor(
    name: string,
    opts?: { requestId?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
}
