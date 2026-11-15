/**
 * 工具事件线上裁剪（0.6.1 E12）。
 *
 * core 的 `tool.call.started` 已带 `arguments`、`tool.call.completed` 已带 `result`；
 * gateway 在出站（redactor 之后、入 buffer 之前）统一裁剪到 8 KiB，
 * 避免大工具结果撑爆事件缓冲/浏览器。
 *
 * 0.52：同一把尺子也用在**历史读路径**（`sessions.get` 的 `capToolMessages`），
 * 否则「实时看到 8 KiB、刷新后看到完整」会让同一条工具结果有两种口径。
 *
 * @module @vessel-agent/serve/tool-events
 */

import type { Message, RunEvent } from '@vessel-agent/core';

/** 单个字段的序列化上限（UTF-8 字节） */
export const TOOL_EVENT_PAYLOAD_LIMIT = 8 * 1024;

/** 截断标记（ASCII，稳定可测） */
export const TRUNCATED_MARKER = '... [truncated]';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 截断标记的 UTF-8 字节数（模块级预算，不用每次重新编码） */
const TRUNCATED_MARKER_BYTES = encoder.encode(TRUNCATED_MARKER).length;

/**
 * 按 UTF-8 字节截断，返回不超过 maxBytes 的前缀。
 * 只对已编码的字节做一次游标回退：从 `end = maxBytes` 起，遇到续字节
 * （`10xxxxxx`）就左移，直到落在字符起始边界，再解码 `[0, end)`。
 * 不做逐字符 slice + 重新 encode 的循环。
 */
function truncateUtf8(bytes: Uint8Array, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
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
 * 一个被裁字段的**结构化**裁断事实（0.54 投影卡，additive）。
 *
 * 存在的理由：0.52 起「静默截断」只把 `... [truncated]` 拼进字符串，UI 只能靠**找标记**
 * 猜「这条正文是不是不完整」——猜不到原体量，也无法区分「什么都没裁」。这里把
 * `capToolPayload` 内部早就算过的数字（`CappedValue.bytes`）**加字段**下发：
 * 标记串照旧拼（既有 UI 依赖），这里只是把它显式化。
 *
 * 语义边界：`bytes` 是**截断前**完整字段的 UTF-8 字节数，不是出站后的字节数；`limit`
 * 是本次生效的上限（= `TOOL_EVENT_PAYLOAD_LIMIT`）；`marker` 是拼进正文的那串标记，
 * 逐字（客户端不需要硬编码它就能做去重/剥离）。
 */
export interface CappedFieldInfo {
  /** 完整字段的 UTF-8 字节数（**截断前**）。 */
  bytes: number;
  /** 生效上限（UTF-8 字节，= `TOOL_EVENT_PAYLOAD_LIMIT`）。 */
  limit: number;
  /** 拼进正文的截断标记（逐字，= `TRUNCATED_MARKER`）。 */
  marker: string;
}

/**
 * 单条消息上的裁断事实（`Message.truncated` 的线上形状，additive 0.54）。
 *
 * **sparse**：没被裁的消息不带这个字段（不是 `{content: null}`）；被裁时才出现。
 */
export interface MessageTruncation {
  /** 工具结果正文被裁（`role==='tool'`）。 */
  content?: CappedFieldInfo;
  /** assistant 工具入参被裁：`bytes` 取**被裁 call 里的最大原字节数**（不点名是哪一条）。 */
  arguments?: CappedFieldInfo;
  /** `arguments` 为多个 call 的合并值时才出现：被裁的 call 数（≥2）。 */
  arguments_calls?: number;
}

/** 出站消息（`Message` + 裁断事实）。`truncated` 是 wire-only 派生，core 不认识它。 */
export interface CappedMessage extends Message {
  truncated?: MessageTruncation;
}

/** `CappedValue` → 线上形状（只有被裁时才调用）。 */
function cappedFieldInfo(capped: CappedValue): CappedFieldInfo {
  return {
    bytes: capped.bytes,
    limit: TOOL_EVENT_PAYLOAD_LIMIT,
    marker: TRUNCATED_MARKER,
  };
}

/**
 * 把单个字段裁剪到 8 KiB。
 * - 字符串：保留前缀 + 截断标记；
 * - 对象/数组：序列化超限时折叠为 `{truncated:true, preview}`；
 * - 未超限：原值原样返回（类型不变）。
 */
export function capToolPayload(value: unknown): CappedValue {
  const serialized = serialize(value);
  // 一次编码：长度判断与截断共用同一份字节
  const encoded = encoder.encode(serialized);
  if (encoded.length <= TOOL_EVENT_PAYLOAD_LIMIT) {
    return { value, truncated: false, bytes: encoded.length };
  }
  const budget = TOOL_EVENT_PAYLOAD_LIMIT - TRUNCATED_MARKER_BYTES;
  const preview = `${truncateUtf8(encoded, budget)}${TRUNCATED_MARKER}`;
  if (typeof value === 'string') {
    return { value: preview, truncated: true, bytes: encoded.length };
  }
  return {
    value: { truncated: true, preview },
    truncated: true,
    bytes: encoded.length,
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

/** 单条消息的裁剪（内部）；未超限返回原引用。 */
function capToolMessage(message: Message): CappedMessage {
  let next: CappedMessage | null = null;
  const truncation: MessageTruncation = {};

  // 工具结果消息：content 就是工具输出。
  if (message.role === 'tool' && typeof message.content === 'string') {
    const capped = capToolPayload(message.content);
    if (capped.truncated) {
      next = { ...message, content: capped.value as string };
      truncation.content = cappedFieldInfo(capped);
    }
  }

  // assistant 的工具入参：与实时 `tool.call.started.arguments` 同一口径。
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && toolCalls.length > 0) {
    let changed = false;
    let cappedCalls = 0;
    let maxBytes = 0;
    const nextCalls = toolCalls.map((call) => {
      const args = call.function?.arguments;
      if (typeof args !== 'string') return call;
      const capped = capToolPayload(args);
      if (!capped.truncated) return call;
      changed = true;
      cappedCalls += 1;
      maxBytes = Math.max(maxBytes, capped.bytes);
      return { ...call, function: { ...call.function, arguments: capped.value as string } };
    });
    if (changed) {
      next = { ...(next ?? message), tool_calls: nextCalls };
      truncation.arguments = {
        bytes: maxBytes,
        limit: TOOL_EVENT_PAYLOAD_LIMIT,
        marker: TRUNCATED_MARKER,
      };
      // 多个 call 分批被裁时合并成一个数（不点名），但要说清是几条 —— 否则 UI 会把
      // 「最大值」读成「这条消息只有一处被裁」。
      if (cappedCalls > 1) truncation.arguments_calls = cappedCalls;
    }
  }

  return next === null ? message : { ...next, truncated: truncation };
}

/**
 * 历史读路径裁剪（0.52）：把一批消息里的工具输出 / 工具入参裁到 8 KiB。
 *
 * - 与实时流同源（`capToolPayload` + `... [truncated]` 标记，文案一致）；
 * - **不改存储**：入参通常是刚 parse 出来的 `state.messages`，返回副本；
 * - 未截断的消息保留原引用，全部未截断时返回原数组（零分配）；
 * - 0.54（additive）：被裁的消息同时带结构化 `truncated`（`bytes` / `limit` / `marker`），
 *   字符串里那串标记**照旧拼**（既有 UI 读它），这里只是把裁断事实显式化。
 *
 * 调用方注意：`sessions.get` 的分页游标用**裁剪前**的 `content.length` 校验历史一致性，
 * 裁剪必须发生在游标计算之后（两边都用原长度才稳定）。
 */
export function capToolMessages(messages: readonly Message[]): CappedMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    const capped = capToolMessage(message);
    if (capped !== message) changed = true;
    return capped;
  });
  return changed ? out : (messages as CappedMessage[]);
}
