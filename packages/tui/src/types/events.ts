/**
 * TUI 消费侧事件类型（hermes 式消费侧 discriminated union）
 * @module @vessel/tui
 *
 * core 的 RunEvent 为开放字符串协议（ADR-030：type: string），编译器无法据 type 收窄 data，
 * 消费方被迫 per-case `event.data as {...}`。本模块在订阅边界用 asTuiEvent() 一次性 cast 到闭 union，
 * 之后 switch 自动 narrow data，消费方不再写 as。未在 union 内的事件落 default 分支忽略。
 *
 * 设计依据：hermes-agent 的 GatewayEvent（消费侧单方面声明 + 入口一处盲转 asGatewayEvent）。
 * core 的 RunEvent 不变（ADR-030 合规、core 冻结不动、插件自定义事件零影响）。
 */

import type {
  GuardrailBlockedPayload,
  LlmStreamChunkPayload,
  RunCompletedPayload,
  RunEvent,
  RunFailedPayload,
  RunStartedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
} from '@vessel/core';
import type { AskUserRequestedData } from '../renderer/ask-user.js';
import type { ToolPermissionRequestedData } from '../renderer/tool-confirm.js';

/** TUI 订阅的事件（core 事件 + 交互暂停事件），type 字面量做判别符 */
export type TuiEvent =
  | { type: 'run.started'; run_id: string; data: RunStartedPayload; ts: number }
  | { type: 'llm.stream.chunk'; run_id: string; data: LlmStreamChunkPayload; ts: number }
  | { type: 'tool.call.started'; run_id: string; data: ToolCallStartedPayload; ts: number }
  | { type: 'tool.call.completed'; run_id: string; data: ToolCallCompletedPayload; ts: number }
  | { type: 'tool.call.failed'; run_id: string; data: ToolCallFailedPayload; ts: number }
  | { type: 'guardrail.blocked'; run_id: string; data: GuardrailBlockedPayload; ts: number }
  | { type: 'run.completed'; run_id: string; data: RunCompletedPayload; ts: number }
  | { type: 'run.failed'; run_id: string; data: RunFailedPayload; ts: number }
  | {
      type: 'tool.permission.request';
      run_id: string;
      data: ToolPermissionRequestedData;
      ts: number;
    }
  | { type: 'ask.user.requested'; run_id: string; data: AskUserRequestedData; ts: number };

/**
 * 订阅边界 cast：RunEvent（开放字符串）-> TuiEvent（闭 union）。
 * 等价 hermes asGatewayEvent--集中盲转，使用点免 as。RunEvent 已保证 type: string，
 * 此处只承诺 type↔payload 映射；未在 union 内的事件落消费方 default 分支。
 */
export function asTuiEvent(event: RunEvent): TuiEvent {
  return event as TuiEvent;
}
