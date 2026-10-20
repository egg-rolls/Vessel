/**
 * 工具事件线上裁剪（0.6.1 E12）。
 *
 * core 的 `tool.call.started` 已带 `arguments`、`tool.call.completed` 已带 `result`；
 * gateway 在出站（redactor 之后、入 buffer 之前）统一裁剪到 8 KiB，
 * 避免大工具结果撑爆事件缓冲/浏览器。
 *
 * @module @vessel/serve/tool-events
 */

import type { RunEvent } from '@vessel/core';

/** 单个字段的序列化上限（UTF-8 字节） */
export const TOOL_EVENT_PAYLOAD_LIMIT = 8 * 1024;

/** 截断标记（ASCII，稳定可测） */
export const TRUNCATED_MARKER = '... [truncated]';

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** 按 UTF-8 字节截断，返回不超过 maxBytes 的前缀 */
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Length(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  let result = value.slice(0, end);
  while (end > 0 && utf8Length(result) > maxBytes) {
    end -= 1;
    result = value.slice(0, end);
  }
  return result;
}

/** 序列化值；循环引用等异常退化为 String() */
function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export interface CappedValue {
  value: unknown;
  truncated: boolean;
  bytes: number;
}

/**
 * 把单个字段裁剪到 8 KiB。
 * - 字符串：保留前缀 + 截断标记；
 * - 对象/数组：序列化超限时折叠为 `{truncated:true, preview}`；
 * - 未超限：原值原样返回（类型不变）。
 */
export function capToolPayload(value: unknown): CappedValue {
  const serialized = serialize(value);
  const bytes = utf8Length(serialized);
  if (bytes <= TOOL_EVENT_PAYLOAD_LIMIT) {
    return { value, truncated: false, bytes };
  }
  const budget = TOOL_EVENT_PAYLOAD_LIMIT - utf8Length(TRUNCATED_MARKER);
  const preview = `${truncateUtf8(serialized, budget)}${TRUNCATED_MARKER}`;
  if (typeof value === 'string') {
    return { value: preview, truncated: true, bytes };
  }
  return {
    value: { truncated: true, preview },
    truncated: true,
    bytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 出站工具事件规整：
 * - `tool.call.started`：`arguments` 原样保留，并补 `args` 别名；
 * - `tool.call.completed`：`result` 原样保留；
 * - 任一字段超限时加 `truncated: true` / `truncated_bytes`。
 */
export function capToolEvent(event: RunEvent): RunEvent {
  if (event.type !== 'tool.call.started' && event.type !== 'tool.call.completed') return event;
  if (!isRecord(event.data)) return event;

  const data: Record<string, unknown> = { ...event.data };
  let truncated = false;
  let truncatedBytes = 0;

  if (event.type === 'tool.call.started') {
    const args = data.arguments !== undefined ? data.arguments : data.args;
    if (args !== undefined) {
      const capped = capToolPayload(args);
      data.arguments = capped.value;
      data.args = capped.value;
      if (capped.truncated) {
        truncated = true;
        truncatedBytes = Math.max(truncatedBytes, capped.bytes);
      }
    }
  } else if (data.result !== undefined) {
    const capped = capToolPayload(data.result);
    data.result = capped.value;
    if (capped.truncated) {
      truncated = true;
      truncatedBytes = Math.max(truncatedBytes, capped.bytes);
    }
  }

  if (!truncated) return { ...event, data };
  return { ...event, data: { ...data, truncated: true, truncated_bytes: truncatedBytes } };
}
