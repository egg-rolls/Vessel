/**
 * 内置脱敏规则与文本替换（供 guardrail 与 trace redactor 共用）。
 */

/** 插件配置（guardrail 与 trace redactor 共用）。 */
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

/** 脱敏规则 */
export interface RedactRule {
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

// ── 内置规则 ──────────────────────────────────────

export const BUILTIN_RULES: RedactRule[] = [
  // Anthropic API Key 必须先于 OpenAI 规则：`sk-ant-...` 也会被 sk- 通配命中
  {
    name: 'anthropic-api-key',
    pattern: /sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '***REDACTED***',
    keepPrefix: 7,
  },
  // OpenAI API Key: sk-...
  {
    name: 'openai-api-key',
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '***REDACTED***',
    keepPrefix: 3,
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

export function redactText(
  text: string,
  rules: RedactRule[],
): { redacted: string; found: string[] } {
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
