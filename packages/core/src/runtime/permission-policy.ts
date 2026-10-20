/**
 * 权限策略（ADR-026/029）——工具执行前的权限判定。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 * @module @vessel-agent/core/runtime
 */

import { randomUUID } from 'node:crypto';
import type { EventStream } from '../types/event.js';
import type { RuntimePermissionConfig } from '../types/plugin.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';

/** checkPermission 返回 'ask' 时等待用户决定的事件超时（毫秒） */
const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * 权限请求超时（0.11.1，DECISION-022 §2.2）。
 *
 * 超时是致命的：调用方必须终止 run，不得把它当作普通工具错误回给模型重试。
 */
export class PermissionTimeoutError extends Error {
  /** 稳定错误码，供事件 / 调用方判定 */
  readonly code = 'permission_timeout' as const;

  constructor(message = 'Permission request timed out') {
    super(message);
    this.name = 'PermissionTimeoutError';
  }
}

/**
 * 权限等待被取消（0.13，DECISION-024 §2.3）。
 *
 * 与 `PermissionTimeoutError` 区分：取消不是 `permission_timeout`，run 按取消收尾；
 * 错误名沿用原生 abort 语义（`AbortError`），message 取 `signal.reason`。
 */
export class PermissionAbortedError extends Error {
  /** 稳定错误码：取消（非超时） */
  readonly code = 'permission_cancelled' as const;

  constructor(reason?: unknown) {
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string' && reason.length > 0
          ? reason
          : 'Permission request cancelled';
    super(message);
    this.name = 'AbortError';
  }
}

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
    private readonly tenantId?: string,
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
      const ts = Date.now();
      this.events.publish({
        type: 'tool.permission.request',
        run_id: ctx.run_id,
        data: {
          requestId,
          tool: tool.name,
          input: args,
          // 0.13（DECISION-024 §2.1）：交互事件与 run / session / tool call 关联，additive。
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          ...(ctx.tool_call_id !== undefined ? { tool_call_id: ctx.tool_call_id } : {}),
          deadline_at: ts + PERMISSION_TIMEOUT_MS,
          source: ctx.source ?? 'runtime',
        },
        ts,
        ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
      });
      const decided = (await this.waitForDecision(tool, requestId, ctx)) as
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

  /**
   * 等待用户决定；超时抛 `PermissionTimeoutError`（0.11.1）。
   * 0.13（DECISION-024 §2.3）：等待绑定 `ctx.signal`；abort 时立即结束并把取消错误
   * 原样抛出，不得等满 120s 后误报 `permission_timeout`。
   */
  private async waitForDecision(
    tool: ToolDefinition,
    requestId: string,
    ctx: ToolContext,
  ): Promise<unknown> {
    try {
      return await this.events.waitFor('tool.permission.response', {
        requestId,
        timeout: PERMISSION_TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      // 取消优先于超时：run 已被中止时保留取消语义，不转换成权限超时。
      if (ctx.signal?.aborted) {
        throw new PermissionAbortedError(ctx.signal.reason ?? error);
      }
      throw new PermissionTimeoutError(
        `Permission request for tool "${tool.name}" timed out after ${PERMISSION_TIMEOUT_MS}ms`,
      );
    }
  }
}
