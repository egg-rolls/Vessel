/**
 * RPC 辅助：错误识别、展示格式化与输出脱敏
 * @module @vessel/tui
 *
 * TUI 只依赖 RpcClientLike 的结构（repl-context.ts），不 import asm / core 的实现。
 * - 方法级错误在 HTTP 上是 200 + ok:false（A-3 §10.2），client 统一抛 {code, message}；
 * - details 从不进入展示文本，避免把参数 / 密钥带出来。
 */

import { classifyError, formatClassifiedError } from './error-classifier.js';
import type { RpcErrorCodeLike, RpcErrorLike } from './repl-context.js';

/** 冻结错误码（DECISION-010 §2.3） */
export const RPC_ERROR_CODES: readonly RpcErrorCodeLike[] = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_params',
  'tenant_locked',
  'quota_exceeded',
  'conflict',
  'internal',
];

const RPC_ERROR_CODE_SET = new Set<string>(RPC_ERROR_CODES);

/** 敏感键名（精确匹配，大小写不敏感） */
const SENSITIVE_KEYS = new Set([
  'api_key',
  'apikey',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'app_secret',
  'password',
  'authorization',
]);

/** app_id 类键名：只显示前 4 位 */
const APP_ID_KEYS = new Set(['app_id', 'appid']);

/** 字符串里的常见密钥前缀 */
const SECRET_STRING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]+/g, 'sk-***'],
  [/Bearer\s+[^\s"']+/gi, 'Bearer ***'],
];

const MAX_REDACT_DEPTH = 8;

export function isRpcErrorCode(value: unknown): value is RpcErrorCodeLike {
  return typeof value === 'string' && RPC_ERROR_CODE_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为带冻结 code 的错误对象（RpcClientError 结构兼容） */
export function isRpcError(value: unknown): value is RpcErrorLike {
  return isRecord(value) && isRpcErrorCode(value.code) && typeof value.message === 'string';
}

/** 读取错误码；非 RPC 错误返回 undefined */
export function readRpcCode(error: unknown): RpcErrorCodeLike | undefined {
  if (isRpcError(error)) return error.code;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 格式化为 TUI 展示文本。
 * RPC 错误显示 `✗ [code] message`；其它错误沿用既有分类器。
 */
export function formatRpcError(error: unknown): string {
  const code = readRpcCode(error);
  if (code) {
    const message = isRpcError(error) ? error.message : errorMessage(error);
    return `✗ [${code}] ${message}`;
  }
  return formatClassifiedError(classifyError(error));
}

function redactString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function maskAppId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length <= 4 ? '***' : `${value.slice(0, 4)}***`;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_REDACT_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const lower = childKey.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      result[childKey] = '***';
    } else if (APP_ID_KEYS.has(lower)) {
      result[childKey] = maskAppId(childValue);
    } else {
      result[childKey] = redactValue(childValue, depth + 1);
    }
  }
  return result;
}

/**
 * 输出脱敏（TUI 侧兜底；服务端已脱敏时幂等）。
 * - 敏感键 → `***`；app_id → 前 4 位 + `***`；
 * - 字符串中的 `sk-*` / `Bearer *` → 打码；
 * - 不修改入参。
 */
export function redactForDisplay<T = unknown>(value: T): T {
  return redactValue(value, 0) as T;
}
