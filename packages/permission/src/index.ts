/**
 * @vessel-agent/permission — 共享权限原语
 * @module @vessel-agent/permission
 *
 * 旧版自描述工具对象（ADR-026）的 `checkPermission` 可复用本函数：发
 * `tool.permission.request` 事件 → `waitFor('tool.permission.response', { requestId })`
 * 等用户授权（ADR-029）。仓库内的 bash / edit 已改为返回 `'ask'`，由 core
 * `PermissionPolicy` 统一提问；本函数保留给外部插件。
 *
 * 默认无限等待（ADR-079）：只有显式正数 `timeout` 才计时，超时兜底返回 `'ask'`。
 * 事件名为开放字符串协议（ADR-030），不定义常量。
 */

import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@vessel-agent/core';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * 用事件流等待用户授权（ADR-029 / ADR-079）。
 * 发 `tool.permission.request` 事件 → `waitFor('tool.permission.response', { requestId })`。
 * 默认不设超时；只有显式正数 `timeout` 才会在超时后兜底返回 `'ask'`。
 */
export async function requestPermission(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  timeout?: number,
): Promise<PermissionDecision> {
  const requestId = randomUUID();
  ctx.events.publish({
    type: 'tool.permission.request',
    run_id: ctx.run_id,
    data: {
      requestId,
      tool,
      input,
      ...(typeof ctx.session_id === 'string' && ctx.session_id.length > 0
        ? { session_id: ctx.session_id }
        : {}),
      ...(ctx.tool_call_id ? { tool_call_id: ctx.tool_call_id } : {}),
      source: ctx.source ?? 'runtime',
    },
    ts: Date.now(),
  });
  const timeoutMs =
    typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
  try {
    const data = (await ctx.events.waitFor('tool.permission.response', {
      requestId,
      // 不传 timeout = 无限等待，不在超时后伪造决定。
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      // run 被取消时不能永远挂着：交给 waitFor 的 abort 通道，catch 后兜底 'ask'。
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    })) as { decision?: PermissionDecision; allowed?: boolean };
    return data.decision ?? (data.allowed === false ? 'deny' : 'allow');
  } catch {
    return 'ask';
  }
}
