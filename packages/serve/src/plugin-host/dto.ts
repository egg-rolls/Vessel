/**
 * JSON DTO 边界（CONTRACT-0.43 §2.4）：只允许 JSON 值，单条消息 ≤ 1 MiB。
 * 所有校验失败都抛 `PluginHostError`。
 *
 * 语义基线（O1）：校验 rigor 匹配信任边界。host↔engine 同信任域（同机同用户，
 * 数据出自自己代码），校验语义对齐 JSON.stringify 的实际序列化；故意比 JSON
 * 更严的项在下表标注「更严」并给出理由——理由为资源保护 / 掩盖编程错误，
 * 适用于使用本 DTO 的所有边界（含外部不可信插件边界），不是按调用方分档。
 *
 * 语义对照表（jsonDtoViolation vs JSON.stringify）：
 *
 * | 输入                          | JSON.stringify         | 本校验 | 理由 |
 * |-------------------------------|------------------------|--------|------|
 * | null / string / boolean / 有限数 | 原样                  | 放行   | 对齐 |
 * | undefined 对象属性            | 丢弃键                 | 跳过   | 对齐：可选字段语义（如 tool.invoke 的 boundary / timeout_ms） |
 * | undefined 数组元素            | → null                 | 放行   | 对齐：确定的值变形，接收端拿到 null（db69c381 后续补全） |
 * | 顶层 undefined                | → undefined（非字符串）| 拒绝   | 消息体本身必须是 JSON 值 |
 * | function / symbol（任何位置） | 对象丢弃 / 数组 → null | 拒绝   | 更严：跨 wire 必是编程错误，静默丢弃 / null 化掩盖 bug |
 * | bigint                        | throw TypeError        | 拒绝   | 对齐：不可序列化 |
 * | NaN / ±Infinity               | → null                 | 拒绝   | 更严：数值计算 bug 信号，null 化掩盖错误 |
 * | Date / Map / 类实例等非 plain object | toJSON / 可枚举属性 | 拒绝 | 更严：DTO 必须纯数据，拒绝隐式序列化魔法 |
 * | 循环引用                      | throw TypeError        | 拒绝   | 对齐 |
 * | 深度 > MAX_DEPTH (32)         | 无限制（栈溢出风险）   | 拒绝   | 更严：资源保护，防恶意嵌套拖垮宿主 |
 *
 * 本表即契约文档（不写测试文件，宪法第三/四条）。不变量 owner = 本文件
 * visit / ensurePayload（host 出口单实现）；oracle = 用户行为验证 + 构建产物读数 +
 * 只读真实日志。分层职责、去重判定与逐条 owner/oracle 登记见
 * docs/dev/research/validation-layering.md。
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
      // 顶层 undefined / function / symbol / bigint：见头部语义对照表。
      // bigint 对齐 JSON.stringify（throw）；function / symbol 故意更严（跨 wire 必是编程错误）。
      return `${path} is not a JSON value`;
  }
  if (depth >= MAX_DEPTH) return `${path} is nested too deeply`;
  const object = value as object;
  if (seen.has(object)) return `${path} contains a cycle`;
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        // undefined 数组元素被 JSON.stringify 序列化为 null：确定的值变形，
        // 对齐 wire 语义放行（区别于 undefined 对象属性的「丢弃键」）。
        if (value[index] === undefined) continue;
        const failure = visit(value[index], `${path}[${index}]`, depth + 1, seen);
        if (failure !== null) return failure;
      }
      return null;
    }
    if (!isPlainObject(value)) return `${path} must be a plain object`;
    for (const [key, child] of Object.entries(value)) {
      // undefined 对象属性被 JSON.stringify 丢弃，跳过以对齐 wire 语义。
      if (child === undefined) continue;
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
