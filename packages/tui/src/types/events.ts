/**
 * TUI 消费侧事件类型（hermes 式消费侧 discriminated union）
 * @module @vessel-agent/tui
 *
 * core 的 RunEvent 为开放字符串协议（ADR-030：type: string），编译器无法据 type 收窄 data，
 * 消费方被迫 per-case `event.data as {...}`。本模块在订阅边界用 asTuiEvent() 一次性 cast 到闭 union，
 * 之后 switch 自动 narrow data，消费方不再写 as。
 *
 * 0.18：union 补齐 0.17 生产者实际发布的 `agent.*` / `limit.blocked` / `context.compacted` /
 * `agent.queue.*` / `agent.limit.warning`；未识别的事件不再被静默盲转，而是落到显式的
 * `{ type: 'unknown' }` 分支（类型上可见，消费方可以忽略或记为 notice）。
 */

import type {
  GuardrailBlockedPayload,
  LlmResponsePayload,
  LlmStreamChunkPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunStartedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
} from '@vessel-agent/core';
import type { AskUserAnsweredData, AskUserRequestedData } from '../renderer/ask-user.js';
import type {
  ToolPermissionDecidedData,
  ToolPermissionRequestedData,
} from '../renderer/tool-confirm.js';

/** update.available 载荷（由 asm 的启动检查发布；TUI 只消费，不实现网络） */
export interface UpdateAvailableData {
  /** 当前版本 */
  current: string;
  /** 可用新版本 */
  latest: string;
  /** 通道 */
  channel: 'latest' | 'beta';
  /** 给用户的升级命令/提示 */
  installHint: string;
  /** release notes 链接（可选） */
  notesUrl?: string;
}

/** 成员事件载荷：字段按 snake_case / camelCase 双拼读取，这里只声明常用字段。 */
export interface AgentEventData extends Record<string, unknown> {
  agent_id?: string;
  agentId?: string;
  delegate_id?: string;
  delegateId?: string;
  state?: string;
  task?: string;
  tool?: string;
  tool_name?: string;
  position?: number;
  wait_reason?: string;
}

/** limit.blocked / agent.limit.warning 载荷（0.14.3 / 0.15） */
export interface LimitEventData extends Record<string, unknown> {
  error_code?: string;
  scope?: string;
  key?: string;
  current?: number;
  max?: number;
  source?: string;
  threshold?: number;
  hint?: string;
  retryable?: boolean;
  run_id?: string;
  session_id?: string;
}

/** context.compacted 载荷（0.15） */
export interface CompactedEventData extends Record<string, unknown> {
  run_id?: string;
  session_id?: string;
  removed?: number;
  remaining?: number;
  reason?: 'auto' | 'overflow' | 'manual';
}

/** `user.message` 载荷（0.18 事件日志；message 为实际写入上下文的用户消息） */
export interface UserMessageData extends Record<string, unknown> {
  message?: unknown;
}

/**
 * 事件投影只依赖的最小形状：`RunEvent` 与 `SessionEventRecord` 都满足。
 * 事件日志记录的 `data` 是 unknown，投影边界按 type 收窄。
 */
export interface RunEventLike {
  type: string;
  run_id: string;
  data: unknown;
  ts: number;
}

/** 未识别事件：类型上可见，默认忽略（不丢进 data 盲转） */
export interface TuiUnknownEvent {
  type: 'unknown';
  /** 原始开放字符串事件名 */
  eventType: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
}

/** TUI 订阅的事件（core 事件 + 交互暂停事件 + 成员事件），type 字面量做判别符 */
export type TuiEvent =
  | { type: 'run.started'; run_id: string; data: RunStartedPayload; ts: number }
  /** 0.18：事件日志中的用户原文（run.started.input 是 guardrail 改写前文本） */
  | { type: 'user.message'; run_id: string; data: UserMessageData; ts: number }
  /** 0.18：事件日志中的 assistant 回合（content / tool_calls / reasoning） */
  | { type: 'llm.response'; run_id: string; data: LlmResponsePayload; ts: number }
  | { type: 'llm.stream.chunk'; run_id: string; data: LlmStreamChunkPayload; ts: number }
  | { type: 'tool.call.started'; run_id: string; data: ToolCallStartedPayload; ts: number }
  | { type: 'tool.call.completed'; run_id: string; data: ToolCallCompletedPayload; ts: number }
  | { type: 'tool.call.failed'; run_id: string; data: ToolCallFailedPayload; ts: number }
  | { type: 'guardrail.blocked'; run_id: string; data: GuardrailBlockedPayload; ts: number }
  | { type: 'run.completed'; run_id: string; data: RunCompletedPayload; ts: number }
  | {
      type: 'run.failed';
      run_id: string;
      data: RunFailedPayload & { partial_content?: string };
      ts: number;
    }
  /** 用户主动取消：载荷形状与 failed 一致，可选携带取消原因 */
  | {
      type: 'run.cancelled';
      run_id: string;
      data: RunFailedPayload & { reason?: string; partial_content?: string };
      ts: number;
    }
  /** durable resume 开始（core 开放事件；TUI 当作一次新的运行开始处理） */
  | { type: 'run.resumed'; run_id: string; data: Record<string, unknown>; ts: number }
  | {
      type: 'tool.permission.request';
      run_id: string;
      data: ToolPermissionRequestedData;
      ts: number;
    }
  | {
      type: 'tool.permission.response';
      run_id: string;
      data: ToolPermissionDecidedData;
      ts: number;
    }
  | { type: 'ask.user.requested'; run_id: string; data: AskUserRequestedData; ts: number }
  | { type: 'ask.user.answered'; run_id: string; data: AskUserAnsweredData; ts: number }
  | { type: 'update.available'; run_id: string; data: UpdateAvailableData; ts: number }
  // ── 0.17 成员（agent.*）事件；subagent.* 已无生产者，只由旧 trace 回放读取 ──
  | { type: 'agent.spawned'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.turn.started'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.turn.completed'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.turn.failed'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.turn.cancelled'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.message.queued'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.message.sent'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.closed'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.stale'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.permission.requested'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.permission.responded'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.queue.entered'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.queue.left'; run_id: string; data: AgentEventData; ts: number }
  | { type: 'agent.limit.warning'; run_id: string; data: LimitEventData; ts: number }
  // ── 透明化事件（0.14.3 / 0.15） ──
  | { type: 'limit.blocked'; run_id: string; data: LimitEventData; ts: number }
  | { type: 'context.compacted'; run_id: string; data: CompactedEventData; ts: number }
  | TuiUnknownEvent;

/** 已知事件名（用于订阅边界判定；未知事件走 `{ type: 'unknown' }`）。 */
export const KNOWN_TUI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'user.message',
  'llm.response',
  'llm.stream.chunk',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  'guardrail.blocked',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.resumed',
  'tool.permission.request',
  'tool.permission.response',
  'ask.user.requested',
  'ask.user.answered',
  'update.available',
  'agent.spawned',
  'agent.turn.started',
  'agent.turn.completed',
  'agent.turn.failed',
  'agent.turn.cancelled',
  'agent.message.queued',
  'agent.message.sent',
  'agent.closed',
  'agent.stale',
  'agent.permission.requested',
  'agent.permission.responded',
  'agent.queue.entered',
  'agent.queue.left',
  'agent.limit.warning',
  'limit.blocked',
  'context.compacted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 订阅边界 cast：RunEvent（开放字符串）-> TuiEvent（闭 union）。
 * 已知事件集中盲转（只承诺 type↔payload 映射）；未识别事件映射到显式 unknown 分支，
 * 不再把任意 `event.data as {...}` 的假设扩散到消费方。
 */
export function asTuiEvent(event: RunEventLike): TuiEvent {
  if (!KNOWN_TUI_EVENT_TYPES.has(event.type)) {
    return {
      type: 'unknown',
      eventType: event.type,
      run_id: event.run_id,
      data: isRecord(event.data) ? event.data : {},
      ts: event.ts,
    };
  }
  return event as unknown as TuiEvent;
}

/** 事件名是否在 TUI 已知集合内 */
export function isKnownTuiEventType(type: string): boolean {
  return KNOWN_TUI_EVENT_TYPES.has(type);
}
