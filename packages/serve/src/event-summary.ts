/**
 * WS 广播摘要化（0.18 D7）。
 *
 * sequenced 广播与回放只携带摘要：完整 payload 仍在 raw fan-in、trace 与
 * 会话日志中，避免大消息撑爆 WS 帧与浏览器内存。
 *
 * 只处理 `llm.request` 与 `context.changed`；其他事件原样返回同一引用。
 * 不修改输入对象，目标事件返回新事件。
 *
 * @module @vessel-agent/serve/event-summary
 */

import type { RunEvent } from '@vessel-agent/core';

/** 广播摘要中单条消息预览的 UTF-16 code unit 上限 */
export const BROADCAST_PREVIEW_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 截断到上限；切点落在高代理项上时丢弃孤立代理项，避免非法 UTF-16。 */
function truncatePreview(text: string): string {
  if (text.length <= BROADCAST_PREVIEW_LIMIT) return text;
  const sliced = text.slice(0, BROADCAST_PREVIEW_LIMIT);
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return sliced.slice(0, -1);
  return sliced;
}

function toolCallNames(toolCalls: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const fn = call.function;
    if (typeof call.name === 'string') names.push(call.name);
    else if (isRecord(fn) && typeof fn.name === 'string') names.push(fn.name);
  }
  return names;
}

/** 单条消息的预览：content 优先，其次 tool_calls，否则空串。 */
function previewOf(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return truncatePreview(message.content);
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return truncatePreview(`[tool_calls: ${toolCallNames(toolCalls).join(', ')}]`);
  }
  return '';
}

function lastMessageOf(message: unknown): { role: string; preview: string } | undefined {
  if (!isRecord(message)) return undefined;
  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    preview: previewOf(message),
  };
}

function summarizeLlmRequest(event: RunEvent, data: Record<string, unknown>): RunEvent {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  // 其余字段（tools / 脱敏后的凭据标记等）原样保留；只去掉完整 messages。
  const next: Record<string, unknown> = { ...data };
  delete next.messages;

  next.run_id = typeof data.run_id === 'string' ? data.run_id : event.run_id;
  if (typeof data.session_id === 'string') next.session_id = data.session_id;
  else delete next.session_id;
  next.message_count = messages.length;
  if (typeof data.token_count === 'number') next.token_count = data.token_count;
  else delete next.token_count;

  if (messages.length > 0) {
    const last = lastMessageOf(messages[messages.length - 1]);
    if (last) next.last_message = last;
    else delete next.last_message;
  } else {
    delete next.last_message;
  }

  return { ...event, data: next };
}

function summarizeContextChanged(event: RunEvent, data: Record<string, unknown>): RunEvent {
  // 其余字段原样保留；完整 message 换成预览。
  const next: Record<string, unknown> = { ...data };
  delete next.message;

  next.run_id = typeof data.run_id === 'string' ? data.run_id : event.run_id;
  if (typeof data.session_id === 'string') next.session_id = data.session_id;
  else delete next.session_id;
  next.message_count = typeof data.message_count === 'number' ? data.message_count : 1;
  if (typeof data.token_count === 'number') next.token_count = data.token_count;
  else delete next.token_count;

  const last = lastMessageOf(data.message);
  if (last) next.last_message = last;
  else delete next.last_message;

  return { ...event, data: next };
}

/**
 * 把出站事件压成广播摘要。
 * 非目标事件返回原引用；目标事件的 data 不是对象时也返回原引用。
 */
export function summarizeBroadcastEvent(event: RunEvent): RunEvent {
  if (event.type !== 'llm.request' && event.type !== 'context.changed') return event;
  if (!isRecord(event.data)) return event;
  return event.type === 'llm.request'
    ? summarizeLlmRequest(event, event.data)
    : summarizeContextChanged(event, event.data);
}
