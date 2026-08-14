/**
 * Guardrail 编排器（四阶段）。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 * @module @vessel/core/runtime
 */

import type { EventStream } from '../types/event.js';
import type { GuardrailContext, GuardrailStage } from '../types/guardrail.js';
import type { PluginHost } from '../types/plugin.js';

/** Guardrail 判定结果 */
export interface GuardrailOutcome {
  allowed: boolean;
  replacement?: unknown;
  reason?: string;
}

/** 依次应用某阶段的 guardrail，任一阻止即短路返回。 */
export class GuardrailRunner {
  constructor(
    private host: PluginHost,
    private events: EventStream,
  ) {}

  async apply(
    value: unknown,
    stage: GuardrailStage,
    runId: string,
    sessionId?: string,
  ): Promise<GuardrailOutcome> {
    const guardrails = this.host.getGuardrails().filter((g) => g.stage === stage);
    const ctx: GuardrailContext = { run_id: runId, session_id: sessionId, stage };

    let currentValue = value;
    for (const guardrail of guardrails) {
      const result = await guardrail.check(currentValue, ctx);
      if (!result.allowed) {
        this.events.publish({
          type: 'guardrail.blocked',
          run_id: runId,
          data: {
            run_id: runId,
            guardrail_name: guardrail.name,
            stage,
            reason: result.reason ?? 'blocked',
          },
          ts: Date.now(),
        });
        return { allowed: false, replacement: currentValue, reason: result.reason };
      }
      if (result.replacement !== undefined) {
        currentValue = result.replacement;
      }
    }
    return { allowed: true, replacement: currentValue };
  }
}
