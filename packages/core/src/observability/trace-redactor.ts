/**
 * 默认 trace 脱敏（0.5 F2 / DECISION-010 §2.2、E7）
 *
 * - 键名匹配 api_key|apikey|token|secret|password|authorization|app_secret → `***`
 * - 字符串匹配 `sk-` / `Bearer <token>` / JWT / AWS AccessKey → `***`
 * - `app_id` 保留前 4 位 + `***`
 * - deep clone，不修改原事件；深度上限 8；WeakSet 防环
 *
 * @module @vessel/core/observability
 */

import type { RunEvent } from '../types/event.js';
import type { TraceRedactor } from '../types/trace.js';

const SENSITIVE_KEY = /api[_-]?key|token|secret|password|authorization|app_secret/i;
/**
 * 字符串里的凭据模式（0.10 R2-14）：sk-、Bearer、JWT、AWS AccessKey。
 * 最小模式，只覆盖高置信度前缀，避免把普通文本整段打码。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\s)sk-[A-Za-z0-9_-]{4,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
];
const MAX_DEPTH = 8;

function isSecretString(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/** `app_id` / `appId` / `APP_ID` 归一化为 `appid` */
function isAppIdKey(key: string): boolean {
  return key.toLowerCase().replace(/_/g, '') === 'appid';
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return isSecretString(value) ? '***' : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[redacted]';
  if (seen.has(value)) return '[redacted]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      // 数值/布尔不是密钥；保留 usage.* token 计数（metadata 白名单需要）
      result[key] = typeof entry === 'number' || typeof entry === 'boolean' ? entry : '***';
      continue;
    }
    if (isAppIdKey(key) && typeof entry === 'string') {
      result[key] = `${entry.slice(0, 4)}***`;
      continue;
    }
    result[key] = redactValue(entry, depth + 1, seen);
  }
  return result;
}

/** 默认 redactor 实现 */
export function createDefaultTraceRedactor(): TraceRedactor {
  return {
    redact(event: RunEvent): RunEvent {
      const data = redactValue(event.data, 0, new WeakSet<object>());
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
