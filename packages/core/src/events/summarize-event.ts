/**
 * 大 payload 事件摘要化（0.18 D7，0.52 下沉到 core）。
 *
 * 两个消费面共用同一份摘要口径：
 * - **WS 广播/回放**：完整 payload 仍在 raw fan-in 中（`llm.stream.chunk` 不进
 *   trace，`llm.request` 的正文只活在内存事件流里），摘要避免大消息撑爆 WS 帧
 *   与浏览器内存；
 * - **trace 落盘**（0.52）：`llm.request` 的完整 messages 是每轮 prompt 全量副本，
 *   实测占 trace 目录字节的 98.6%（1,278 条 / 1,308 MB，均值 1 MB/条），
 *   而 `events.list` 的消费者只查 error 类型。落盘时换成摘要后，
 *   目录从 GB 级回到几十 MB，`events.list` 不再为一份 99% 会被丢弃的副本付费。
 *
 * 注意与**会话事件日志**的口径区别：日志里 `llm.request` 落的是另一套更窄的元信息
 * 副本（`content_omitted: true` + 计数，见 `runtime/run-journal.ts`），流式正文则由
 * `llm.stream.summary` 的定长骨架替代。本模块只服务广播与 trace，不改日志。
 *
 * 只处理 `llm.request` 与 `context.changed`；其他事件原样返回同一引用。
 * 不修改输入对象，目标事件返回新事件。
 *
 * @module @vessel-agent/core/events/summarize-event
 */

import type { RunEvent } from '../types/event.js';

/** 摘要中单条消息预览的 UTF-16 code unit 上限 */
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

/**
 * 只摘要 `llm.request`（trace 落盘用）。
 *
 * 与广播摘要同源：丢掉完整 `messages`，保留 `tools`、`message_count`、
 * `token_count` 与末条消息预览；其他类型原样返回同一引用。
 */
export function summarizeLlmRequestEvent(event: RunEvent): RunEvent {
  if (event.type !== 'llm.request') return event;
  if (!isRecord(event.data)) return event;
  return summarizeLlmRequest(event, event.data);
}
