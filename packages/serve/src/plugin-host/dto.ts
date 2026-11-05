/**
 * JSON DTO 边界（CONTRACT-0.43 §2.4）：只允许 JSON 值，单条消息 ≤ 1 MiB。
 *
 * 拒绝函数 / 类实例 / Date / Map / 循环引用 / 非有限数；深度有上限，
 * 避免宿主被恶意嵌套拖垮。所有校验失败都抛 `PluginHostError`。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { PluginHostError, pluginError } from './errors.js';
import type { PluginEventDto } from './types.js';

/** 单条消息上限（contract §2.4） */
export const MAX_PLUGIN_MESSAGE_BYTES = 1024 * 1024;

/** 事件 DTO 上限（与消息上限一致，留出信封余量） */
export const MAX_PLUGIN_EVENT_BYTES = 512 * 1024;

const MAX_DEPTH = 32;

/** 递归脱敏的键（精确匹配；不碰 `prompt_tokens` / `cache_read_tokens` 这类计数键） */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'api_key',
  'apiKey',
  'apikey',
  'app_id',
  'app_secret',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
]);

const REDACTED = '[redacted]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 校验 JSON DTO。返回失败路径说明；通过返回 null。
 * `path` 只用于错误信息，不包含值本身。
 */
export function jsonDtoViolation(value: unknown, path = 'value'): string | null {
  return visit(value, path, 0, new Set<object>());
}

function visit(value: unknown, path: string, depth: number, seen: Set<object>): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(value) ? null : `${path} must be a finite number`;
    case 'object':
      break;
    default:
      // undefined / function / symbol / bigint
      return `${path} is not a JSON value`;
  }
  if (depth >= MAX_DEPTH) return `${path} is nested too deeply`;
  const object = value as object;
  if (seen.has(object)) return `${path} contains a cycle`;
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = visit(value[index], `${path}[${index}]`, depth + 1, seen);
        if (failure !== null) return failure;
      }
      return null;
    }
    if (!isPlainObject(value)) return `${path} must be a plain object`;
    for (const [key, child] of Object.entries(value)) {
      const failure = visit(child, `${path}.${key}`, depth + 1, seen);
      if (failure !== null) return failure;
    }
    return null;
  } finally {
    seen.delete(object);
  }
}

/** 抛错的 DTO 校验 */
export function ensureJsonDto(value: unknown, path = 'value'): void {
  const failure = jsonDtoViolation(value, path);
  if (failure !== null) {
    throw pluginError('plugin_manifest_invalid', `Invalid JSON DTO: ${failure}`, { path });
  }
}

/** 序列化后的 UTF-8 字节数；不可序列化 → Infinity。 */
export function jsonByteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 校验 DTO + 字节上限；超限 → `plugin_payload_too_large`。 */
export function ensurePayload(
  value: unknown,
  path: string,
  limit = MAX_PLUGIN_MESSAGE_BYTES,
): void {
  ensureJsonDto(value, path);
  const bytes = jsonByteLength(value);
  if (bytes > limit) {
    throw pluginError('plugin_payload_too_large', `${path} exceeds ${limit} bytes`, {
      path,
      bytes,
      limit,
    });
  }
}

/** 递归按键名脱敏；返回新对象，不修改输入。 */
export function redactPluginValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactPluginValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redactPluginValue(child, depth + 1);
  }
  return output;
}

/** 宿主侧把未知事件转成 `plugin.event` 的 params；非法事件丢弃。 */
export function toPluginEventDto(
  event: { type?: unknown; ts?: unknown; data?: unknown; [key: string]: unknown },
  now = Date.now(),
): PluginEventDto | null {
  const type = event.type;
  if (typeof type !== 'string' || type.length === 0) return null;
  const ts = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : now;
  const rawData = event.data;
  const data = isPlainObject(rawData) ? rawData : {};
  const redacted = redactPluginValue(data);
  if (!isPlainObject(redacted)) return null;
  return { type, ts, data: redacted };
}

/** 校验事件 DTO（大小 / 结构）；失败返回 null。 */
export function normalizePluginEventDto(event: PluginEventDto | null): PluginEventDto | null {
  if (event === null) return null;
  if (jsonDtoViolation(event, 'event') !== null) return null;
  if (jsonByteLength(event) > MAX_PLUGIN_EVENT_BYTES) return null;
  return event;
}

export { PluginHostError };
