/**
 * Hook 编排器（五阶段）。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 * @module @vessel/core/runtime
 */

import type { HookContext, HookType } from '../types/hook.js';
import type { PluginHost } from '../types/plugin.js';

/** 依次运行某阶段的 hook。 */
export class HookRunner {
  constructor(private host: PluginHost) {}

  async run(type: HookType, ctx: HookContext): Promise<void> {
    const hooks = this.host.getHooks().filter((h) => h.type === type);
    for (const hook of hooks) {
      await hook.run(ctx);
    }
  }
}
