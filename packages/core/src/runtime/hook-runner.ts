/**
 * Hook 编排器（五阶段）。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 *
 * 0.5：发 `hook.started` / `hook.completed` / `hook.failed`（DECISION-010 §2.2）。
 *
 * @module @vessel/core/runtime
 */

import type { EventStream } from '../types/event.js';
import type { HookContext, HookType } from '../types/hook.js';
import type { PluginHost } from '../types/plugin.js';

/** 依次运行某阶段的 hook。 */
export class HookRunner {
  constructor(
    private host: PluginHost,
    private events?: EventStream,
    private readonly tenantId?: string,
  ) {}

  async run(type: HookType, ctx: HookContext): Promise<void> {
    const hooks = this.host.getHooks().filter((h) => h.type === type);
    for (const hook of hooks) {
      const startedAt = Date.now();
      this.publish('hook.started', {
        hook_name: hook.name,
        hook_type: type,
        run_id: ctx.run_id,
        ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
      });

      try {
        await hook.run(ctx);
        this.publish('hook.completed', {
          hook_name: hook.name,
          hook_type: type,
          run_id: ctx.run_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          duration_ms: Date.now() - startedAt,
        });
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
