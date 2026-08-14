/**
 * 共享权限工具工厂（ADR-026 / ADR-029）。
 *
 * 自描述工具对象的 `checkPermission` 复用本函数：发 `tool.permission.request`
 * 事件 → `waitFor('tool.permission.response', { requestId })` 等用户授权。
 * 无订阅者/超时时兜底返回 'ask'，交由运行时决定。
 *
 * 事件名为开放字符串协议（ADR-030），不定义常量。
 */
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@vessel/core';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * 用事件流等待用户授权（ADR-029）。
 * 发 `tool.permission.request` 事件 → `waitFor('tool.permission.response', { requestId })`。
 * 无订阅者/超时时兜底返回 'ask'，交由运行时决定。
 */
export async function requestPermission(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  timeout = 30000,
): Promise<PermissionDecision> {
  const requestId = randomUUID();
  ctx.events.publish({
    type: 'tool.permission.request',
    run_id: ctx.run_id,
    data: { requestId, tool, input },
    ts: Date.now(),
  });
  try {
    const data = (await ctx.events.waitFor('tool.permission.response', {
      requestId,
      timeout,
    })) as { decision?: PermissionDecision; allowed?: boolean };
    return data.decision ?? (data.allowed === false ? 'deny' : 'allow');
  } catch {
    return 'ask';
  }
}
