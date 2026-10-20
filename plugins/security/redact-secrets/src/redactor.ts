/**
 * TraceRedactor 适配器（0.5 E7 / A-4 §11.4）。
 *
 * - 只脱敏 `event.data`；信封字段（type/run_id/ts/seq/tenant_id）原样保留；
 * - 键名命中敏感键 → `***`（数值/布尔保留，避免破坏 usage 计数）；
 * - `app_id` 只保留前 4 位 + `***`；
 * - 字符串值套用内置规则（sk- / Bearer / JWT / AWS / GitHub / 私钥 / 连接串）；
 * - 幂等；不修改输入事件。
 */

import type { RunEvent, TraceRedactor } from '@vessel/core';
import { BUILTIN_RULES, type RedactRule, type RedactSecretsConfig, redactText } from './rules.js';

/** 与 core 默认 redactor 对齐的键名集合。 */
const SENSITIVE_KEY = /api[_-]?key|token|secret|password|authorization|app_secret/i;
const MAX_DEPTH = 8;

/** `app_id` / `appId` / `APP_ID` / `APPID` 统一识别。 */
function isAppIdKey(key: string): boolean {
  return key.toLowerCase().replace(/_/g, '') === 'appid';
}

function buildRules(config?: RedactSecretsConfig): RedactRule[] {
  const rules: RedactRule[] = config?.enableBuiltin === false ? [] : [...BUILTIN_RULES];
  for (const extra of config?.extraPatterns ?? []) {
    rules.push({
      name: extra.name,
      pattern: new RegExp(extra.pattern, 'g'),
      replacement: extra.replacement ?? '***REDACTED***',
    });
  }
  return rules;
}

function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  rules: RedactRule[],
): unknown {
  if (typeof value === 'string') {
    return redactText(value, rules).redacted;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[redacted]';
  if (seen.has(value)) return '[redacted]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen, rules));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = typeof entry === 'number' || typeof entry === 'boolean' ? entry : '***';
      continue;
    }
    if (isAppIdKey(key) && typeof entry === 'string') {
      result[key] = `${entry.slice(0, 4)}***`;
      continue;
    }
    result[key] = redactValue(entry, depth + 1, seen, rules);
  }
  return result;
}

/** 创建更严格的 trace redactor；由 asm 在 core 默认 redactor 之后组合。 */
export function createTraceRedactor(config?: RedactSecretsConfig): TraceRedactor {
  const rules = buildRules(config);
  return {
    redact(event: RunEvent): RunEvent {
      const data = redactValue(event.data, 0, new WeakSet<object>(), rules);
      return {
        ...event,
        data: (typeof data === 'object' && data !== null ? data : { value: data }) as Record<
          string,
          unknown
        >,
      };
    },
  };
}
