/**
 * 会话事件 → `Message[]` 纯函数投影（0.18）。
 *
 * 输入是 `events.ndjson` 的记录（或任何 `{type, ts, data}` 序列），输出与
 * ExecutionUnit 写入 WorkingContext 的消息形状一致（不含 system prompt；
 * 调用方按 run 的 systemPrompt 自行补齐）。
 *
 * 覆盖的事实事件：
 * - `user.message`           → `{role:'user', content, refs?}`（`data.message` 优先；
 *                               `refs` 逐条宽松解析，非法项丢弃）
 * - `message.injected`       → `data.message`（BeforeLlm / RunOptions 注入）
 * - `llm.response`           → assistant（content / reasoning_content / tool_calls）
 * - `tool.call.started`      → 用来修正 assistant.tool_calls 的实际 name/arguments
 * - `tool.call.completed`    → `{role:'tool', content: result}`
 * - `tool.call.failed`       → `{role:'tool', content: content ?? "Error: <error>"}`
 * - `run.completed.output`   → 覆盖最后一条无 tool_calls 的 assistant 文本
 * - `message.compaction`     → 压缩摘要（0.32 起由 runtime 记录；带 `kept` 边界时
 *                              按应用侧同一规则替换旧历史，否则只追加摘要）
 * - `session.rewound`        → 把当前投影截到 `keep_projected`（0.37 消息撤回；
 *                              全量重投影时不能复活已删除的消息）
 *
 * 不产生消息的事件（run.* / permission / context.* / limit 等）直接忽略。
 *
 * @module @vessel-agent/core/session
 */

import { formatClearedToolResult, isClearedToolResult } from '../context/index.js';
import {
  MESSAGE_REF_PATH_MAX,
  MESSAGE_REFS_MAX,
  type Message,
  type MessageRef,
  type MessageRefKind,
} from '../types/provider.js';
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

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) result.push(entry);
  }
  return result;
}

const REF_KINDS: ReadonlySet<string> = new Set<MessageRefKind>(['file', 'image', 'document']);

/**
 * 宽松解析 `Message.refs`（与 `timestamp` 同形的「能认就留、认不出就丢」）。
 *
 * 逐条校验、逐条丢弃：一条坏引用不能把整条消息（乃至整段历史）判成非法——
 * 事件日志里的 refs 是写侧已经过闸门的形状，这里只防手改 / 旧版本 / 半成品数据。
 * 条数与 `path` 长度按写侧同一上限截断，避免投影出比闸门更宽的历史。
 */
function asRefs(value: unknown): MessageRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: MessageRef[] = [];
  for (const entry of value) {
    if (refs.length >= MESSAGE_REFS_MAX) break;
    if (!isRecord(entry)) continue;
    const kind = entry.kind;
    if (typeof kind !== 'string' || !REF_KINDS.has(kind)) continue;
    const path = readString(entry.path);
    if (path === undefined || path.length === 0 || path.length > MESSAGE_REF_PATH_MAX) continue;
    const ref: MessageRef = { kind: kind as MessageRefKind, path };
    const name = readString(entry.name);
    if (name !== undefined) ref.name = name;
    const mime = readString(entry.mime);
    if (mime !== undefined) ref.mime = mime;
    const bytes = readCount(entry.bytes);
    if (bytes !== undefined) ref.bytes = bytes;
    refs.push(ref);
  }
  return refs.length > 0 ? refs : undefined;
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
  // 附件引用：只有路径与元信息。不补 = 落盘后（重放 / 会话历史）引用凭空消失。
  const refs = asRefs(value.refs);
  if (refs !== undefined) message.refs = refs;
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
    if (event.type === 'session.rewound') {
      // 0.37：撤回是「删除尾部」事实。`keep_projected` 是投影空间下标；
      // 旧事件缺该字段时退回 `keep_messages`（两者在无 base system 时相同）。
      const keepProjected = readCount(data.keep_projected) ?? readCount(data.keep_messages);
      if (keepProjected !== undefined && messages.length > keepProjected) {
        messages.length = keepProjected;
      }
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'message.compaction') {
      const message = asMessage(data.message) ?? {
        role: 'system' as const,
        content: readString(data.summary) ?? '',
        compaction_summary: true,
      };
      message.timestamp ??= event.ts;
      // 0.34 S1：先按 cleared_tool_call_ids 把已构建消息里命中的 tool 结果
      // 换回确定性占位（与压缩时同一函数），再按 `kept` 裁剪。
      // 已是占位的保持幂等；旧事件没有该字段时整段跳过。
      const clearedIds = readStringArray(data.cleared_tool_call_ids);
      if (clearedIds.length > 0) {
        const wanted = new Set(clearedIds);
        for (const entry of messages) {
          if (entry.role !== 'tool') continue;
          const id = entry.tool_call_id;
          if (id === undefined || !wanted.has(id)) continue;
          if (!entry.content || isClearedToolResult(entry.content)) continue;
          entry.content = formatClearedToolResult(messages, id, entry.content);
        }
      }
      // 压缩是「替换」而不是「追加」：应用侧保留全部 system + 最近 `kept`
      // 条非 system，并移除旧摘要。没有 `kept` 的旧事件只追加摘要。
      const kept = readCount(data.kept);
      if (kept === undefined) {
        messages.push(message);
      } else {
        const prior = messages.filter((entry) => entry.compaction_summary !== true);
        const systemMessages = prior.filter((entry) => entry.role === 'system');
        const nonSystem = prior.filter((entry) => entry.role !== 'system');
        const tail =
          kept >= nonSystem.length ? nonSystem : nonSystem.slice(nonSystem.length - kept);
        messages.length = 0;
        messages.push(...systemMessages, message, ...tail);
      }
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

/**
 * 0.37：`SessionState.messages` 下标 → `projectMessages` 投影空间下标。
 *
 * `projectMessages` 不产生 base system prompt；当 `messages[0]` 是非压缩 system
 * 时它只存在于缓存，投影下标比 state 下标小 1。其余消息 1:1。
 */
export function projectedKeepCount(messages: readonly Message[], keep: number): number {
  const first = messages[0];
  const hasBaseSystem =
    first !== undefined && first.role === 'system' && first.compaction_summary !== true;
  return Math.max(0, keep - (hasBaseSystem ? 1 : 0));
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
    // 引用也是内容的一部分：两条只差 refs 的消息不能算同一条（否则增量合并会丢引用）。
    (message.refs ?? []).map((ref) => `${ref.kind}:${ref.path}`).join('|'),
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
