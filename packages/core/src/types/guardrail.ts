/**
 * Guardrail 类型定义
 * @module @vessel/core/guardrail
 */

/** Guardrail 阶段枚举 */
export enum GuardrailStage {
  Input = 'input',
  Output = 'output',
  ToolCall = 'tool_call',
  ToolResult = 'tool_result',
}

/** Guardrail 上下文 */
export interface GuardrailContext {
  run_id: string;
  session_id?: string;
  stage: GuardrailStage;
  metadata?: Record<string, unknown>;
}

/** Guardrail 结果 */
export interface GuardrailResult {
  allowed: boolean;
  replacement?: unknown;
  reason?: string;
}

/** Guardrail 接口 */
export interface Guardrail {
  name: string;
  stage: GuardrailStage;
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>;
  priority?: number;
}
