/**
 * Hook 编排器（五阶段）。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 *
 * 0.5：发 `hook.started` / `hook.completed` / `hook.failed`（DECISION-010 §2.2）。
 *
 * @module @vessel/core/runtime
 */

import type { EventStream } from '../types/event.js';
import type { HookContext, HookResult, HookType } from '../types/hook.js';
import type { PluginHost } from '../types/plugin.js';

/**
 * 依次运行某阶段的 hook。
 *
 * 0.6.1 P2：聚合 hook 返回值——`updatedInput` 写回 ctx.input 供后续 hook/handler 使用，
 * `additionalContext` 拼接，`block` 短路后续 hook。返回 `{}` 表示全部不干预，
 * 因此旧的 `await runner.run(...)`（忽略返回值）保持兼容。
 */
export class HookRunner {
  constructor(
    private host: PluginHost,
    private events?: EventStream,
    private readonly tenantId?: string,
  ) {}

  async run(type: HookType, ctx: HookContext): Promise<HookResult> {
    const hooks = this.host.getHooks().filter((h) => h.type === type);
    const merged: HookResult = {};

    for (const hook of hooks) {
      const startedAt = Date.now();
      this.publish('hook.started', {
        hook_name: hook.name,
        hook_type: type,
        run_id: ctx.run_id,
        ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
      });

      try {
        const result = await hook.run(ctx);
        this.publish('hook.completed', {
          hook_name: hook.name,
          hook_type: type,
          run_id: ctx.run_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          duration_ms: Date.now() - startedAt,
        });

        if (!result) continue;

        if (result.updatedInput !== undefined) {
          // 后续 hook 与工具 handler 看到改写后的输入
          ctx.input = result.updatedInput;
          merged.updatedInput = result.updatedInput;
        }
        if (result.additionalContext) {
          merged.additionalContext = merged.additionalContext
            ? `${merged.additionalContext}\n${result.additionalContext}`
            : result.additionalContext;
        }
        if (result.block) {
          merged.block = true;
          if (result.reason !== undefined) merged.reason = result.reason;
          return merged;
        }
      } catch (error) {
        this.publish('hook.failed', {
          hook_name: hook.name,
          hook_type: type,
          run_id: ctx.run_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return merged;
  }

  private publish(type: string, data: Record<string, unknown>): void {
    if (!this.events) return;
    const runId = typeof data.run_id === 'string' ? data.run_id : 'hook';
    this.events.publish({
      type,
      run_id: runId,
      data,
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}
