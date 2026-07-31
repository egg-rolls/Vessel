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

// ── 类型 ──────────────────────────────────────────

/** 脱敏规则 */
interface RedactRule {
  /** 规则名称 */
  name: string;
  /** 正则表达式 */
  pattern: RegExp;
  /** 替换文本 */
  replacement: string;
  /** 在替换前是否保留前缀（如 "sk-"） */
  keepPrefix?: number;
  /** 在替换前是否保留后缀 */
  keepSuffix?: number;
}

/** 插件配置 */
export interface RedactSecretsConfig {
  /** 自定义额外规则 */
  extraPatterns?: Array<{
    name: string;
    pattern: string;
    replacement?: string;
  }>;
  /** 是否启用所有内置规则 */
  enableBuiltin?: boolean;
}

// ── 内置规则 ──────────────────────────────────────

const BUILTIN_RULES: RedactRule[] = [
  // OpenAI API Key: sk-...
  {
    name: 'openai-api-key',
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '***REDACTED***',
    keepPrefix: 3,
  },
  // Anthropic API Key: sk-ant-...
  {
    name: 'anthropic-api-key',
    pattern: /sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '***REDACTED***',
    keepPrefix: 7,
  },
  // Generic API Key pattern: key=xxxxx
  {
    name: 'generic-api-key',
    pattern: /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"]?([A-Za-z0-9_-]{16,})['"]?/gi,
    replacement: '***REDACTED***',
  },
  // Bearer token
  {
    name: 'bearer-token',
    pattern: /bearer\s+[A-Za-z0-9_\-.=]{16,}/gi,
    replacement: 'Bearer ***REDACTED***',
  },
  // JWT token
  {
    name: 'jwt-token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '***JWT-REDACTED***',
  },
  // AWS Access Key
  {
    name: 'aws-access-key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '***AWS-KEY-REDACTED***',
  },
  // AWS Secret Key (heuristic)
  {
    name: 'aws-secret-key',
    pattern: /(?:aws[_-]?secret|secret[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{30,})['"]?/gi,
    replacement: '***AWS-SECRET-REDACTED***',
  },
  // GitHub Personal Access Token
  {
    name: 'github-token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
    replacement: '***GITHUB-TOKEN-REDACTED***',
  },
  // Generic password field
  {
    name: 'password-field',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
    replacement: 'password: "***REDACTED***"',
  },
  // Private key header
  {
    name: 'private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '***PRIVATE-KEY-REDACTED***',
  },
  // Connection strings with credentials
  {
    name: 'connection-string',
    pattern: /(?:mongodb|mysql|postgres|postgresql|redis):\/\/[^:]+:[^@]+@/gi,
    replacement: '***CONNECTION-STRING-REDACTED***',
  },
];

// ── 脱敏函数 ──────────────────────────────────────

function applyRule(text: string, rule: RedactRule): string {
  return text.replace(rule.pattern, (match) => {
    if (rule.keepPrefix && match.length > rule.keepPrefix) {
      const prefix = match.slice(0, rule.keepPrefix);
      return prefix + rule.replacement;
    }
    if (rule.keepSuffix && match.length > rule.keepSuffix) {
      const suffix = match.slice(-rule.keepSuffix);
      return rule.replacement + suffix;
    }
    return rule.replacement;
  });
}

function redactText(text: string, rules: RedactRule[]): { redacted: string; found: string[] } {
  let result = text;
  const found: string[] = [];

  for (const rule of rules) {
    const before = result;
    result = applyRule(result, rule);
    if (result !== before) {
      found.push(rule.name);
    }
  }

  return { redacted: result, found };
}

// ── Guardrail ─────────────────────────────────────

function createRedactGuardrail(rules: RedactRule[], stage: GuardrailStage): Guardrail {
  return {
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

export const redactSecretsPlugin: Plugin = {
  name: 'redact-secrets',
  version: '0.1.0',
  description:
    'Secret redaction plugin — detects and redacts API keys, tokens, and passwords in tool results and outputs',
  install(host: PluginHost, config?: unknown) {
    const pluginConfig = (config as RedactSecretsConfig) ?? {};
    const enableBuiltin = pluginConfig.enableBuiltin ?? true;

    // 组装规则
    const rules: RedactRule[] = enableBuiltin ? [...BUILTIN_RULES] : [];

    if (pluginConfig.extraPatterns) {
      for (const extra of pluginConfig.extraPatterns) {
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

export default redactSecretsPlugin;
