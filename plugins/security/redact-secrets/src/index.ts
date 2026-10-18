/**
 * @vessel/redact-secrets - 密钥/敏感信息脱敏插件
 * @module @vessel/redact-secrets
 *
 * 自动检测并脱敏 API Key、Token、密码等敏感信息。
 * - ToolResult 阶段（脱敏工具返回结果）
 * - Output 阶段（脱敏 LLM 输出）
 * Tier 1。
 */

import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  Plugin,
  PluginHost,
} from '@vessel/core';
import { GuardrailStage } from '@vessel/core';
import { BUILTIN_RULES, type RedactRule, type RedactSecretsConfig, redactText } from './rules.js';

export { createTraceRedactor } from './redactor.js';
export type { RedactSecretsConfig } from './rules.js';

// ── Guardrail ─────────────────────────────────────

function createRedactGuardrail(rules: RedactRule[], stage: GuardrailStage): Guardrail {
  return {
    name: 'redact-secrets',
    stage,
    priority: 10, // 高优先级，在其他 guardrail 之前执行
    check: async (value: unknown, _ctx: GuardrailContext): Promise<GuardrailResult> => {
      if (typeof value !== 'string') {
        // 尝试序列化非字符串值
        const str = JSON.stringify(value);
        const { redacted, found } = redactText(str, rules);
        if (found.length > 0) {
          try {
            return {
              allowed: true,
              replacement: JSON.parse(redacted),
              reason: `已脱敏: ${found.join(', ')}`,
            };
          } catch {
            return { allowed: true };
          }
        }
        return { allowed: true };
      }

      const { redacted, found } = redactText(value, rules);

      if (found.length > 0) {
        return {
          allowed: true,
          replacement: redacted,
          reason: `已脱敏: ${found.join(', ')}`,
        };
      }

      return { allowed: true };
    },
  };
}

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建 Redact Secrets 插件
 */
export function createRedactSecretsPlugin(config?: RedactSecretsConfig): Plugin {
  return {
    name: 'redact-secrets',
    version: '0.1.0',
    description:
      'Secret redaction plugin — detects and redacts API keys, tokens, and passwords in tool results and outputs',
    install(host: PluginHost) {
      const enableBuiltin = config?.enableBuiltin ?? true;

      // 组装规则
      const rules: RedactRule[] = enableBuiltin ? [...BUILTIN_RULES] : [];

      if (config?.extraPatterns) {
        for (const extra of config.extraPatterns) {
          rules.push({
            name: extra.name,
            pattern: new RegExp(extra.pattern, 'g'),
            replacement: extra.replacement ?? '***REDACTED***',
          });
        }
      }

      // 注册 ToolResult 阶段脱敏（工具返回值中的密钥）
      host.registerGuardrail(createRedactGuardrail(rules, GuardrailStage.ToolResult));

      // 注册 Output 阶段脱敏（LLM 输出中的密钥）
      host.registerGuardrail(createRedactGuardrail(rules, GuardrailStage.Output));
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const redactSecretsPlugin = createRedactSecretsPlugin();

export default redactSecretsPlugin;
