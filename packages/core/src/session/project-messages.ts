/**
 * 会话事件 → `Message[]` 纯函数投影（0.18）。
 *
 * 输入是 `events.ndjson` 的记录（或任何 `{type, ts, data}` 序列），输出与
 * AgentRuntime 写入 ContextManager 的消息形状一致（不含 system prompt；
 * 调用方按 run 的 systemPrompt 自行补齐）。
 *
 * 覆盖的事实事件：
 * - `user.message`           → `{role:'user', content}`（`data.message` 优先）
 * - `message.injected`       → `data.message`（BeforeLlm / RunOptions 注入）
 * - `llm.response`           → assistant（content / reasoning_content / tool_calls）
 * - `tool.call.started`      → 用来修正 assistant.tool_calls 的实际 name/arguments
 * - `tool.call.completed`    → `{role:'tool', content: result}`
 * - `tool.call.failed`       → `{role:'tool', content: content ?? "Error: <error>"}`
 * - `run.completed.output`   → 覆盖最后一条无 tool_calls 的 assistant 文本
 * - `message.compaction`     → 压缩摘要（若未来记录；当前会话文件仍是摘要来源）
 *
 * 不产生消息的事件（run.* / permission / context.* / limit 等）直接忽略。
 *
 * @module @vessel-agent/core/session
 */

import type { Message } from '../types/provider.js';
import type { ToolCall } from '../types/tool.js';

/** 投影所需的最小事件形状（与 `SessionEventRecord` 结构兼容） */
export interface ProjectableEvent {
  type: string;
  ts: number;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 宽松校验一条 Message（只信结构，不做业务解释） */
function asMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const content = typeof value.content === 'string' ? value.content : '';
  const message: Message = { role, content };
  if (Array.isArray(value.tool_calls)) message.tool_calls = value.tool_calls as ToolCall[];
  const toolCallId = readString(value.tool_call_id);
  if (toolCallId !== undefined) message.tool_call_id = toolCallId;
  const name = readString(value.name);
  if (name !== undefined) message.name = name;
  const reasoning = readString(value.reasoning_content);
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) {
    message.timestamp = value.timestamp;
  }
  if (value.compaction_summary === true) message.compaction_summary = true;
  return message;
}

function dataOf(event: ProjectableEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function asToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = readString(entry.id);
    const fn = entry.function;
    if (id === undefined || !isRecord(fn)) continue;
    const name = readString(fn.name);
    const args = readString(fn.arguments);
    if (name === undefined || args === undefined) continue;
    calls.push({ id, type: 'function', function: { name, arguments: args } });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * 把事件序列投影成 `Message[]`。
 *
 * 事件应已按 `seq` 升序；函数不排序、不读取文件。
 */
export function projectMessages(events: Iterable<ProjectableEvent>): Message[] {
  const list = [...events];

  // 先收集工具调用的实际执行参数：guardrail / hook 可能改写 name/arguments。
  const toolStarts = new Map<string, { name: string; arguments: string }>();
  for (const event of list) {
    if (event.type !== 'tool.call.started') continue;
    const data = dataOf(event);
    const id = readString(data.tool_call_id);
    const name = readString(data.tool_name);
    if (id === undefined || name === undefined) continue;
    const args = data.arguments;
    toolStarts.set(id, {
      name,
      // started 事件里非法 JSON 时保留原字符串；projection 只保证结构一致。
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  }

  const messages: Message[] = [];
  let lastAssistant: Message | undefined;

  for (const event of list) {
    const data = dataOf(event);
    if (event.type === 'user.message') {
      const message = asMessage(data.message) ?? {
        role: 'user',
        content: readString(data.content) ?? '',
      };
      message.timestamp ??= event.ts;
      messages.push(message);
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'message.injected') {
      const message = asMessage(data.message);
      if (message) {
        message.timestamp ??= event.ts;
        messages.push(message);
        lastAssistant = undefined;
      }
      continue;
    }
    if (event.type === 'message.compaction') {
      const message = asMessage(data.message) ?? {
        role: 'system' as const,
        content: readString(data.summary) ?? '',
        compaction_summary: true,
      };
      message.timestamp ??= event.ts;
      messages.push(message);
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'llm.response') {
      const content = readString(data.content) ?? '';
      const reasoning = readString(data.reasoning);
      const toolCalls = asToolCalls(data.tool_calls);
      if (toolCalls) {
        const effective = toolCalls.map((call) => {
          const started = toolStarts.get(call.id);
          if (!started) return call;
          return {
            ...call,
            function: { name: started.name, arguments: started.arguments },
          };
        });
        const assistant: Message = {
          role: 'assistant',
          content,
          tool_calls: effective,
          timestamp: event.ts,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        };
        messages.push(assistant);
        lastAssistant = undefined;
      } else {
        const assistant: Message = {
          role: 'assistant',
          content,
          timestamp: event.ts,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        };
        messages.push(assistant);
        lastAssistant = assistant;
      }
      continue;
    }
    if (event.type === 'tool.call.completed') {
      const id = readString(data.tool_call_id);
      if (id === undefined) continue;
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: readString(data.result) ?? '',
        timestamp: event.ts,
      });
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'tool.call.failed') {
      const id = readString(data.tool_call_id);
      if (id === undefined) continue;
      const content =
        readString(data.content) ?? `Error: ${readString(data.error) ?? 'tool call failed'}`;
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content,
        timestamp: event.ts,
      });
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'run.completed') {
      const output = readString(data.output);
      // 输出 guardrail 可能改写最终文本；以终态 output 为准。
      if (output !== undefined && lastAssistant !== undefined) {
        lastAssistant.content = output;
      }
    }
  }

  return messages;
}

/** 消息内容签名（忽略 timestamp：事件时间与上下文写入时间会有毫秒差） */
function messageSignature(message: Message): string {
  return [
    message.role,
    message.content,
    message.tool_call_id ?? '',
    message.name ?? '',
    (message.tool_calls ?? [])
      .map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`)
      .join('|'),
    message.compaction_summary === true ? '1' : '0',
  ].join('\u0000');
}

/**
 * 合并「session 缓存」与「事件全量投影」（0.18）。
 *
 * 用于旧数据没有 `derived_upto_seq`（无法只重放增量）时：
 * 找到缓存尾部与投影头部的最大重叠 k，只追加 `projected.slice(k)`；
 * 系统消息与压缩摘要只来自缓存（事件日志不含它们）。
 *
 * 无任何重叠时：缓存不短于投影 → 认为缓存更新，原样返回；否则拼接
 * （宁可多一条也不丢历史）。
 */
export function mergeHistoryProjection(cached: Message[], projected: Message[]): Message[] {
  if (projected.length === 0) return cached;
  const cachedBody = cached.filter((message) => message.role !== 'system');
  const max = Math.min(cachedBody.length, projected.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    const tail = cachedBody.slice(cachedBody.length - overlap);
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      const cachedMessage = tail[index];
      const projectedMessage = projected[index];
      if (
        cachedMessage === undefined ||
        projectedMessage === undefined ||
        messageSignature(cachedMessage) !== messageSignature(projectedMessage)
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return [...cached, ...projected.slice(overlap)];
  }
  return cachedBody.length >= projected.length ? cached : [...cached, ...projected];
}
