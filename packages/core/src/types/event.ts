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
  /**
   * 输入消息的 `Message.name`（additive；缺省不写）。
   *
   * 只为把「这条输入是谁说的」带到首帧：`user.message` 要晚一个 Input guardrail
   * 的 await 才到，只认它的渲染首帧会把 A2A 投递先画成用户气泡、再变成卡片。
   * `input` 仍是 guardrail 改写前的正文字符串，语义不变。
   */
  input_name?: string;
}

/**
 * LLM 请求事件 payload。
 *
 * **两副形状**（同一事件、两个消费面）：
 * - 发布出去的那份（live / WS / trace）保持完整：`messages` 正文 + `tools` schema；
 * - 会话事件日志里的那份只有元信息（`content_omitted: true` + 下面这些计数），
 *   正文一律不落盘（`RunJournal` 写盘侧裁剪，见 `runtime/run-journal.ts`）。
 *
 * 目的：能从落盘日志看出「这一轮发了几次请求、每次多大、带几个工具、是不是重试」，
 * 而不必为每轮 prompt 付一份 55MB 级副本。元信息不是内容权威 —— 重建 messages 只认
 * `llm.response` / `user.message` / `tool.*`。
 */
export interface LlmRequestPayload extends BaseEventPayload {
  run_id: string;
  /** 仅发布副本携带（正文；落盘副本恒缺省） */
  messages?: unknown[];
  /** 仅发布副本携带（工具 schema 正文；落盘副本恒缺省） */
  tools?: unknown[];
  session_id?: string;
  /** 落盘副本标记：`messages` / `tools` 正文已被写盘侧裁掉 */
  content_omitted?: true;
  model?: string;
  message_count?: number;
  tools_count?: number;
  /** 上下文窗口的 token 估算（增量缓存里现成的值，不重扫历史） */
  estimated_tokens?: number;
  /** 本次请求在 overflow 重试链里的第几次（1 起；>1 = 重试） */
  attempt?: number;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  include_reasoning?: boolean;
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
    /** CONTRACT-0.29 §3：缓存读计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_read_input_tokens?: number;
    /** CONTRACT-0.29 §3：缓存写计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_creation_input_tokens?: number;
  };
}

/** LLM 流式 chunk 事件 payload（ADR-007：流式=事件订阅；ADR-016） */
export interface LlmStreamChunkPayload extends BaseEventPayload {
  run_id: string;
  chunk: StreamChunk;
}

/**
 * 流式段落摘要 payload（`llm.stream.summary`）。
 *
 * **一个段落结束时发一条，不是每个 delta 一条**，且**不含任何正文 / 思考文本**：
 * 它只留下「思考→工具→正文」的交错骨架与「这段是否连续」的自查依据。
 *
 * - 段定义与既有分段同源：`llm.stream.chunk` 的 kind 切换（text ↔ reasoning）、
 *   `finish` 增量、以及一次请求结束（含中断 / 失败）即收口当前段；
 *   `tool_call_delta` 不断段（与 `apps/web/src/state/events.ts` 的 buildGroup 一致）。
 * - `first_seq` / `last_seq` 是**本 run 内的流式序号**（core 侧按 `llm.stream.chunk`
 *   发布顺序从 1 递增，`finish` / `tool_call_delta` 同样占号）。`chunk` 本身不落盘，
 *   所以这是唯一能在日志里对账的序号：纯段落满足
 *   `last_seq - first_seq + 1 === chunk_count`；跨度更大说明段内有非同 kind 的增量
 *   （工具调用增量 / finish）；相邻两段的跨度之间出现空洞则是丢帧线索。
 * - 本事件不是内容权威：任何重建 messages 的路径都不读它，正文冲突时以
 *   `user.message` / `llm.response` / `tool.*` 为准。
 */
export interface LlmStreamSummaryPayload extends BaseEventPayload {
  run_id: string;
  session_id?: string;
  /** run 内段序号（0 起，按摘要发出顺序递增） */
  segment_index: number;
  kind: 'text' | 'reasoning';
  /** 该段实际收到的增量条数 */
  chunk_count: number;
  /** 该段增量的 UTF-8 字节数（只记数，不留副本） */
  bytes: number;
  /** 该段首个 / 末个增量在本 run 流式序号中的位置（1 起） */
  first_seq: number;
  last_seq: number;
  /** 该段首个 / 末个增量的时刻 */
  started_at: number;
  ended_at: number;
  /** 本次请求发出 → 该段首个增量的毫秒数；只在该次请求的首段上有值 */
  ttft_ms?: number;
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
    /** CONTRACT-0.29 §3：缓存读计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_read_input_tokens?: number;
    /** CONTRACT-0.29 §3：缓存写计数（`prompt_tokens` 的子集；缺省=provider 未上报） */
    cache_creation_input_tokens?: number;
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
  | LlmStreamSummaryPayload
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
  /**
   * ADR-098 C2：写入时持有的 SessionLease fencing token。
   * 装配层可注入校验器（`LeaseServicePort.fenceOf`）；旧 token 拒绝 append。
   * 缺省时不校验（读路径 / 旧生产者保持兼容）。
   */
  fencing_token?: number;
  /**
   * 单次写入是否 fsync；缺省跟随实例（`SessionEventLogOptions.durable`，默认 true）。
   *
   * 只用于「一批写完再统一 fsync」的批量路径（如 seeded create 的种子消息）：
   * 传 false 后**必须**在整批结束时调用 `SessionEventLog.sync()`，否则崩溃时
   * 这批事件可能全部停留页缓存。
   */
  durable?: boolean;
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
 * ExecutionUnit 依赖的事件日志端口（0.18）。
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
  /** 从磁盘读取最后 seq（不需要已打开的 writer；实现可缺省） */
  lastSeq?(sessionId: string): Promise<number | undefined>;
  /** 等待该 session（缺省全部）的写入队列排空 */
  flush(sessionId?: string): Promise<void>;
  /**
   * 把该 session 已入队的事件落盘（fsync）。用于 `append({ durable: false })`
   * 的批量路径：整批写完后调用一次（实现可缺省）。
   */
  sync?(sessionId: string): Promise<void>;
  /** 关闭并移除该 session 的写句柄（run 结束 / idle 回收；实现可缺省） */
  release?(sessionId: string): Promise<void>;
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
