/**
 * 权限策略（ADR-026/029）——工具执行前的权限判定。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 * @module @vessel/core/runtime
 */

import { randomUUID } from 'node:crypto';
import type { EventStream } from '../types/event.js';
import type { RuntimePermissionConfig } from '../types/plugin.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';

/** checkPermission 返回 'ask' 时等待用户决定的事件超时（毫秒） */
const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * 工具执行前的权限判定器。持有 remember-always 状态（跨 run，与运行时生命周期一致）。
 */
export class PermissionPolicy {
  private defaultDecision: 'allow' | 'ask';
  private autoApprove: Set<string>;
  private approved: Set<string>;

  constructor(
    private events: EventStream,
    config?: RuntimePermissionConfig,
  ) {
    this.defaultDecision = config?.default ?? 'allow';
    this.autoApprove = new Set(config?.autoApprove ?? []);
    this.approved = new Set();
  }

  /**
   * 判定并放行/拒绝工具执行。允许则正常返回；拒绝则抛错。
   * - 工具自带 checkPermission → 用工具的判定；
   * - 未声明 → 默认策略：default='ask'（且非 autoApprove/已记住）走事件流确认。
   *   库默认 'allow'（不确认），交互模式由 app 层传 permission.default='ask' 开启。
   */
  async authorize(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<void> {
    let decision: 'allow' | 'deny' | 'ask';
    if (tool.checkPermission) {
      decision = await tool.checkPermission(args, ctx);
    } else if (
      this.defaultDecision === 'allow' ||
      this.autoApprove.has(tool.name) ||
      this.approved.has(tool.name)
    ) {
      decision = 'allow';
    } else {
      decision = 'ask';
    }

    if (decision === 'deny') {
      throw new Error(`Tool "${tool.name}" execution denied by permission policy`);
    }
    if (decision === 'ask') {
      const requestId = randomUUID();
      this.events.publish({
        type: 'tool.permission.request',
        run_id: ctx.run_id,
        data: { requestId, tool: tool.name, input: args },
        ts: Date.now(),
      });
      const decided = (await this.events.waitFor('tool.permission.response', {
        requestId,
        timeout: PERMISSION_TIMEOUT_MS,
      })) as
        | { decision?: 'allow' | 'deny' | 'ask'; allowed?: boolean; remember?: boolean }
        | undefined;
      const userDecision = decided?.decision ?? (decided?.allowed === false ? 'deny' : 'allow');
      if (userDecision !== 'allow') {
        throw new Error(`Tool "${tool.name}" execution denied by user`);
      }
      // 用户选 "always" → 记住，后续同工具不再确认
      if (decided?.remember) {
        this.approved.add(tool.name);
      }
    }
  }
}
