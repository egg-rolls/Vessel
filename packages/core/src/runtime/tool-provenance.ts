/**
 * 工具执行位置溯源（tools-engine P2，O4 additive）。
 *
 * 与 `tool-result-gate.ts` 同形的显式回执槽，不是新协议字段：
 * - **transport**：转发 handler（engine-client，装配层）在派发前把执行位置登记在
 *   本次调用的 `ToolContext` 上；管道认领后带成 `ToolPipelineResult.transport`，
 *   由调用方（ExecutionUnit）additive 写进 `tool.call.completed/failed` 的 data。
 *   缺省（无回执）= 旧事件 / in_process，逐字节不变。
 * - **via_bridge**：vessel-bridge guardrail 改写 ToolCall 时（C-05 保留原 id 的
 *   replacement 对象）打标；loop / EU 在发 `tool.call.*` 时按对象身份读取。
 *   WeakMap 随 ToolCall 对象回收，无泄漏、无 id 串台。
 *
 * 机制在 core（事件由调用方发布，ADR-058 决策 4），打标方在装配层 / 插件；
 * core 不认识 engine，只认识「执行位置」这个开放字符串。
 *
 * @module @vessel-agent/core/runtime
 */

import type { ToolCall, ToolContext } from '../types/tool.js';

/** 执行位置（O4 additive 可选字段；缺省 = in_process / 旧事件）。 */
export type ToolTransport = 'in_process' | 'engine_worker' | 'engine_callback';

const transportReceipts = new WeakMap<ToolContext, ToolTransport>();

/** 登记本次调用的执行位置（转发 handler 用；幂等，后写覆盖）。 */
export function markToolTransport(ctx: ToolContext, transport: ToolTransport): void {
  transportReceipts.set(ctx, transport);
}

/** 认领执行位置回执（管道用；取走即删，与 gate receipt 同口径）。 */
export function takeToolTransport(ctx: ToolContext): ToolTransport | undefined {
  const transport = transportReceipts.get(ctx);
  if (transport !== undefined) transportReceipts.delete(ctx);
  return transport;
}

const bridgeCalls = new WeakMap<ToolCall, true>();

/** 打标「这次调用是 vessel-bridge 改写的」（guardrail replacement 对象，C-05 同 id）。 */
export function markBridgeCall(toolCall: ToolCall): void {
  bridgeCalls.set(toolCall, true);
}

/** 读取桥溯源（loop / EU 发事件时用；只读不删——started/completed/failed 都要读）。 */
export function isBridgeCall(toolCall: ToolCall): boolean {
  return bridgeCalls.get(toolCall) === true;
}
