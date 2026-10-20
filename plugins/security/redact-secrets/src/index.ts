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

/** E1：`install(host, {config})` 的窄类型（core 尚未声明第二参数） */
export interface PluginInstallOptions {
  config?: Record<string, unknown>;
}

/** 类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 YAML 插件配置解析成 RedactSecretsConfig（非法正则跳过） */
export function parseRedactSecretsConfig(value: unknown): RedactSecretsConfig {
  if (!isRecord(value)) return {};
  const parsed: RedactSecretsConfig = {};
  if (typeof value.enableBuiltin === 'boolean') parsed.enableBuiltin = value.enableBuiltin;

  if (Array.isArray(value.extraPatterns)) {
    const extraPatterns: NonNullable<RedactSecretsConfig['extraPatterns']> = [];
    for (const item of value.extraPatterns) {
      if (!isRecord(item)) continue;
      const name = item.name;
      const pattern = item.pattern;
      if (typeof name !== 'string' || typeof pattern !== 'string') continue;
      try {
        new RegExp(pattern, 'g');
      } catch {
        continue;
      }
      extraPatterns.push({
        name,
        pattern,
        ...(typeof item.replacement === 'string' ? { replacement: item.replacement } : {}),
      });
    }
    parsed.extraPatterns = extraPatterns;
  }

  return parsed;
}

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
    install(host: PluginHost, options?: PluginInstallOptions) {
      const merged = { ...(config ?? {}), ...parseRedactSecretsConfig(options?.config) };
      const enableBuiltin = merged.enableBuiltin ?? true;

      // 组装规则
      const rules: RedactRule[] = enableBuiltin ? [...BUILTIN_RULES] : [];

      if (merged.extraPatterns) {
        for (const extra of merged.extraPatterns) {
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
