/**
 * Guardrail 编排器（四阶段）。
 * 从 AgentRuntime 抽出（ADR-033 编排逻辑外推），保持单一职责。
 *
 * 0.8 C2：`check` 抛错按 fail-closed 处理（blocked + `guardrail_error`），
 * 发 `guardrail.error`，不把异常冒泡成 run 失败。
 * @module @vessel/core/runtime
 */

import type { EventStream } from '../types/event.js';
import type { GuardrailContext, GuardrailResult, GuardrailStage } from '../types/guardrail.js';
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
    private readonly tenantId?: string,
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
      let result: GuardrailResult;
      try {
        result = await guardrail.check(currentValue, ctx);
      } catch (error) {
        // fail-closed：坏 guardrail 视为阻断，不冒泡异常。
        this.publishError(guardrail.name, stage, runId, error);
        return { allowed: false, replacement: currentValue, reason: 'guardrail_error' };
      }
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
          ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
        });
        return { allowed: false, replacement: currentValue, reason: result.reason };
      }
      if (result.replacement !== undefined) {
        currentValue = result.replacement;
      }
    }
    return { allowed: true, replacement: currentValue };
  }

  private publishError(
    guardrailName: string,
    stage: GuardrailStage,
    runId: string,
    error: unknown,
  ): void {
    this.events.publish({
      type: 'guardrail.error',
      run_id: runId,
      data: {
        run_id: runId,
        guardrail_name: guardrailName,
        stage,
        error: error instanceof Error ? error.message : String(error),
      },
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}
