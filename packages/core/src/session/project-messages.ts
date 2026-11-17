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
 * 两条**事实**（`kept` 裁尾 / `rewound` 截断）无条件应用；只有「把工具结果换成占位」
 * 这一件**视图**事可以按调用方要求跳过（见 `ProjectMessagesOptions`）。
 *
 * 消息身份（additive `run_id` / `run_segment`）：`run_id` 取自事件的 `data.run_id`，
 * 段序由 `assignMessageIdentities` 在投影末尾统一补（与落盘漏斗同一个函数）。
 * 缺 `run_id` 的旧事件两个字段都缺省 —— 消费端退回内容比较。
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
import { assignMessageIdentities, withRunIdentity } from './message-identity.js';

/** 投影所需的最小事件形状（与 `SessionEventRecord` 结构兼容） */
export interface ProjectableEvent {
  type: string;
  ts: number;
  data?: unknown;
  /** 事件在日志里的 seq（增量续算要用；旧调用方传的事件没有它 = 不推进游标）。 */
  seq?: number;
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
    // 0.56：内容地址必须活过重放（与 `packages/agent/src/refs.ts` 同一口径）。
    // 丢在投影里 = 恢复后 refs 没有 sha256 ⇒ 图不内联（`not_ingested`）+ GC 把还在用的
    // blob 当孤儿删掉（design §10 风险 3 的「最阴的一类 bug」）。
    const sha256 = readString(entry.sha256);
    if (sha256 !== undefined && /^[0-9a-f]{64}$/.test(sha256)) ref.sha256 = sha256;
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
  // 消息身份（additive）：事件里的消息载荷可能已经带 `run_id`（`context.changed`）；
  // `run_segment` 一律由投影末尾的 `assignMessageIdentities` 统一补，不从载荷里信。
  const runId = readString(value.run_id);
  if (runId !== undefined && runId.length > 0) message.run_id = runId;
  // 消息身份（additive，0.56）：`message_id` 是写入侧盖的**事实**，投影必须原样带出去 ——
  // 丢在这里，历史那份就永远没有 id，前端只能退回内容比较（正是要根除的那件事）。
  const messageId = readString(value.message_id);
  if (messageId !== undefined && messageId.length > 0) message.message_id = messageId;
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
 * 给投影出来的消息补 `run_id`（身份取自事件载荷的 `data.run_id`）。
 *
 * 为什么投影也要盖：resume / 崩溃恢复走的是「事件 → 消息」这条重建路径，投影不带身份
 * 就等于刷新之后又没有身份可用（Web 认领退回内容比较 = 本条 bug 复现）。`run_id` 是事件
 * 自带的字段，抄进消息不改任何内容；已带身份的（`data.message.run_id`）不覆盖。
 */
function withEventRunId(message: Message, data: Record<string, unknown>): Message {
  const runId = readString(data.run_id);
  return runId === undefined ? message : withRunIdentity(message, runId);
}

/**
 * 投影选项。
 *
 * 只有「清集替换」（把 `message.compaction.cleared_tool_call_ids` 命中的工具结果换成本段
 * 占位文本）是**视图**行为，可以关掉；`kept` 裁尾与 `session.rewound` 截断是**事实**
 * （压缩真的替换掉了旧历史、撤回真的删掉了尾部），永远照做。
 */
export interface ProjectMessagesOptions {
  /**
   * 是否应用清集替换（占位正文）。
   *
   * - `true`（缺省）：既有行为，投影产物是**请求/展示**口径（占位在正文里）。
   * - `false`：投影产物是**原文**口径 —— 恢复/加载路径必须用这个，否则占位会被
   *   `finalizeSessionState` 写回 `SessionState.messages` 并**永久粘住**（原文只剩
   *   事件日志）。模型视图不靠它：请求构建层按本段冻结集合自己替换
   *   （`withClearedToolResults`）。
   */
  applyClearedReplacements?: boolean;
}

/**
 * 投影游标：把「事件 → 消息」这件事做成**可续算的一步**（第十一条：增量）。
 *
 * 存在理由（0.55 send-latency）：`ExecutionUnit.loadStoredHistory` 每次 run 起点都要
 * 「整份日志 → 消息视图」，0.54 B3 起那次读是**整份读**（58k 事件的会话实测 7.0 s，
 * 占一次发送的 ~92%）。而窗口只会 append，投影本身是**折叠**（fold）：上一段事件折出
 * 的消息 + 尾巴那段事件 = 整份投影，逐条相同。
 *
 * 为什么必须放在本模块：投影口径只能有一份。`projectMessages()` 现在就是
 * 「空游标 + 一次 extend」，两条路走同一个循环体，不可能漂。
 *
 * **共享对象的口径**：游标里的消息对象与调用方拿到的、窗口里的消息对象是**同一批**
 * （不深拷贝 —— 一次会话视图 1.3 MB，每次发送复制一遍没有意义）。所以调用方必须把
 * 投影产物当只读：目前唯一的就地写是 `assignMessageIdentities`（`run_segment`，幂等 +
 * 续编），本模块每次 extend 末尾都会再跑一次，所以共享不会造成漂移。
 */
export interface ProjectionCursor {
  /** 已折出的消息（顺序 = 事件顺序；与 `projectMessages` 的返回值同一口径）。 */
  readonly messages: Message[];
  /**
   * 与 `messages` **逐位对齐**的「这条消息由哪条事件产出」的 seq（0.56 ctx-recall）。
   *
   * 为什么需要它：压缩索引要回答「被替换的 766 条原来在哪」，而消息对象上没有 seq
   * （`Message` 是对 provider 的形状，不该塞内部寻址信息；加字段还会进落盘壳与 projection
   * 快照）。窗口消息与投影消息是**同一批对象**（见 `ProjectionCursor` 注释），所以在投影
   * 时记一份平行数组，运行时播种窗口时按内容对齐一次，压缩那一刻就查得到。
   *
   * 口径：
   * - 一条 `llm.response` 产出的 assistant ⇒ 那条事件的 seq（`tool.call.started` 只回填实参，
   *   **不**改写这个号 —— 消息的身份仍是那次响应）；
   * - `message.compaction` 产出的摘要 ⇒ 该压缩事件的 seq；
   * - `session.rewound` 截掉的消息与 seq 一起截（事实是「删尾部」）；
   * - 不产出消息的事件不占位。
   *
   * 谁也不许把它当判据做业务决策：它只服务「按区间读回被压缩的历史」这一件事。
   */
  readonly messageSeqs: (number | undefined)[];
  /** 当前「最后一条 assistant 正文（无 tool_calls）」—— `run.completed.output` 要就地改它。 */
  lastAssistant: Message | undefined;
  /** `tool_call_id` → `tool.call.started` 里的实际 name/arguments（跨段保留）。 */
  readonly toolStarts: Map<string, { name: string; arguments: string }>;
  /** 构造时钉死的清集替换口径（同一游标只服务一种口径）。 */
  readonly applyClearedReplacements: boolean;
  /** 已折叠的最后一条事件的 seq（没有 seq 的事件不推进它）。 */
  seq: number | undefined;
  /** 已折叠的事件条数（= 整份读的 `events.length`）。 */
  count: number;
  /** 最近一次 `llm.response.usage` 的 per-request 总量（旧 `lastRequestTokensFromEvents` 口径）。 */
  lastRequestTokens: number | undefined;
  /** 事件里出现过 `session.rewound`（`reconcileCachedProjection` 的 `replacementInLog`）。 */
  rewoundSeen: boolean;
}

/**
 * 一条游标里最多记多少个 tool_call 的实参（`PROJECTION_CURSOR_MAX_TOOL_CALLS`）。
 *
 * 它与消息视图同阶（每条 assistant 的 tool_calls 本来就带同一份实参）；超过这个数
 * （极端碎片会话）就不再缓存游标 —— 让内存与落盘快照都有界，代价只是下次整份读。
 *
 * 定义放在本模块（而不是 `runtime/execution-unit.ts`）：落盘快照的序列化也要按它判上界，
 * 而 session 层不许反向依赖 runtime。
 */
export const PROJECTION_CURSOR_MAX_TOOL_CALLS = 20_000;

/** 建一个空游标（`projectMessages` 的起点）。 */
export function createProjectionCursor(options?: ProjectMessagesOptions): ProjectionCursor {
  return {
    messages: [],
    messageSeqs: [],
    lastAssistant: undefined,
    toolStarts: new Map(),
    applyClearedReplacements: options?.applyClearedReplacements ?? true,
    seq: undefined,
    count: 0,
    lastRequestTokens: undefined,
    rewoundSeen: false,
  };
}

/**
 * 把事件序列投影成 `Message[]`。
 *
 * 事件应已按 `seq` 升序；函数不排序、不读取文件。
 */
export function projectMessages(
  events: Iterable<ProjectableEvent>,
  options?: ProjectMessagesOptions,
): Message[] {
  const cursor = createProjectionCursor(options);
  extendProjection(cursor, events);
  return cursor.messages;
}

/**
 * 把一条 `tool.call.started` 的实参回填到**已经建好的** assistant 消息上。
 *
 * 只在一种形状下需要：分段折叠的切点正好落在 `llm.response` 与它的 `tool.call.started`
 * 之间。整份投影的预扫描先收齐全部 started 再建消息，所以那条 assistant 的参数必然被
 * started 覆盖；分段折叠时它已经在上一段建好了，只能回填。
 *
 * 找法：从尾部倒着找第一条**带这个 tool_call id** 的 assistant（id 唯一，命中即停）。
 * 这条路径只在上述罕见切点发生，正常段一次都不会走到（`emittedHere` 已过滤）。
 */
function backfillToolCallStarts(
  messages: readonly Message[],
  toolCallId: string,
  started: { name: string; arguments: string } | undefined,
): void {
  if (started === undefined) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== 'assistant') continue;
    let hit = false;
    for (const call of message.tool_calls ?? []) {
      if (call.id !== toolCallId) continue;
      call.function = { name: started.name, arguments: started.arguments };
      hit = true;
    }
    if (hit) return;
  }
}

/**
 * 把一段（**必须接在游标之后**的）事件折进游标；结果与「整份重投影」逐条相同。
 *
 * 调用方负责保证这段事件紧接 `cursor.seq`（连续性 / 到达日志头这两件事由读侧判，
 * 见 `ExecutionUnit.loadStoredHistory`）——本函数不做猜测：喂进来什么就折什么。
 */
export function extendProjection(
  cursor: ProjectionCursor,
  events: Iterable<ProjectableEvent>,
): void {
  const applyClearedReplacements = cursor.applyClearedReplacements;
  const list = [...events];
  cursor.count += list.length;
  /** 本段里 `tool.call.started` 带来的 id（回填只需要看这一批，不看全部历史）。 */
  const startedHere: string[] = [];

  // 先收集工具调用的实际执行参数：guardrail / hook 可能改写 name/arguments。
  // 跨段保留：一个 `llm.response` 的 `tool.call.started` 可能不在同一段里。
  for (const event of list) {
    if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
      cursor.seq = cursor.seq === undefined ? event.seq : Math.max(cursor.seq, event.seq);
    }
    if (event.type === 'session.rewound') cursor.rewoundSeen = true;
    if (event.type === 'llm.response') {
      const usage = dataOf(event).usage;
      if (isRecord(usage)) {
        const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
        const completion =
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
        if (prompt + completion > 0) cursor.lastRequestTokens = prompt + completion;
      }
    }
    if (event.type !== 'tool.call.started') continue;
    const data = dataOf(event);
    const id = readString(data.tool_call_id);
    const name = readString(data.tool_name);
    if (id === undefined || name === undefined) continue;
    const args = data.arguments;
    startedHere.push(id);
    cursor.toolStarts.set(id, {
      name,
      // started 事件里非法 JSON 时保留原字符串；projection 只保证结构一致。
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  }

  const toolStarts = cursor.toolStarts;
  const messages = cursor.messages;
  /** 与 `messages` 平行的 seq 记录（口径见 `ProjectionCursor.messageSeqs`）。 */
  const messageSeqs = cursor.messageSeqs;
  let lastAssistant = cursor.lastAssistant;
  /**
   * 本段里**新写出**的 tool_call id。
   *
   * 用途只有一个：判断「有没有一条 started 事件属于**上一段**已经落成的 assistant」。
   * 整份投影的预扫描把**全部** started 事件先收齐再构造消息，所以一条 `llm.response`
   * 的参数总是被它后面的 `tool.call.started` 覆盖。分段折叠时，如果切点正好落在
   * `llm.response` 与它的 `tool.call.started` 之间，那条 assistant 在上一段就已经建好了，
   * 预扫描的新条目没有机会作用到它 —— 于是本段末尾补一次回填（见 `backfillStarts`）。
   */
  const emittedHere = new Set<string>();

  for (const event of list) {
    const data = dataOf(event);
    if (event.type === 'user.message') {
      const message = withEventRunId(
        asMessage(data.message) ?? {
          role: 'user',
          content: readString(data.content) ?? '',
        },
        data,
      );
      message.timestamp ??= event.ts;
      messages.push(message);
      messageSeqs.push(event.seq);
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'message.injected') {
      const raw = asMessage(data.message);
      if (raw !== null) {
        const message = withEventRunId(raw, data);
        message.timestamp ??= event.ts;
        messages.push(message);
        messageSeqs.push(event.seq);
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
        // 删尾部是事实：seq 记录跟着截，否则两份数组会错位（错位比缺 seq 更糟）。
        messageSeqs.length = Math.min(messageSeqs.length, keepProjected);
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
      //
      // 0.54：这一步是**视图**（模型会看到什么），不是事实 —— 加载/恢复路径传
      // `applyClearedReplacements: false` 跳过它，让 `SessionState.messages` 保持原文。
      // 注意 `kept` 裁剪（下面一段）**不在**这个开关里：那是压缩真的替换掉了旧历史。
      const clearedIds = applyClearedReplacements
        ? readStringArray(data.cleared_tool_call_ids)
        : [];
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
        messageSeqs.push(event.seq);
      } else {
        // 按下标重建两份数组（消息 + seq）：先按 `prior` 的**下标**分类，
        // 再一次性重排，`messages` 的产物与旧实现逐条相同。
        const keptSeqs: (number | undefined)[] = [];
        const systemIndexes: number[] = [];
        const nonSystemIndexes: number[] = [];
        for (let index = 0; index < messages.length; index += 1) {
          const entry = messages[index];
          if (entry === undefined || entry.compaction_summary === true) continue;
          if (entry.role === 'system') systemIndexes.push(index);
          else nonSystemIndexes.push(index);
        }
        const tailIndexes =
          kept >= nonSystemIndexes.length
            ? nonSystemIndexes
            : nonSystemIndexes.slice(nonSystemIndexes.length - kept);
        const nextMessages: Message[] = [];
        for (const index of systemIndexes) {
          const entry = messages[index];
          if (entry !== undefined) {
            nextMessages.push(entry);
            keptSeqs.push(messageSeqs[index]);
          }
        }
        nextMessages.push(message);
        keptSeqs.push(event.seq);
        for (const index of tailIndexes) {
          const entry = messages[index];
          if (entry === undefined) continue;
          nextMessages.push(entry);
          keptSeqs.push(messageSeqs[index]);
        }
        messages.length = 0;
        messageSeqs.length = 0;
        messages.push(...nextMessages);
        messageSeqs.push(...keptSeqs);
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
          emittedHere.add(call.id);
          const started = toolStarts.get(call.id);
          if (!started) return call;
          return {
            ...call,
            function: { name: started.name, arguments: started.arguments },
          };
        });
        const assistant = withEventRunId(
          {
            role: 'assistant',
            content,
            tool_calls: effective,
            timestamp: event.ts,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          data,
        );
        messages.push(assistant);
        messageSeqs.push(event.seq);
        lastAssistant = undefined;
      } else {
        const assistant = withEventRunId(
          {
            role: 'assistant',
            content,
            timestamp: event.ts,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          data,
        );
        messages.push(assistant);
        messageSeqs.push(event.seq);
        lastAssistant = assistant;
      }
      continue;
    }
    if (event.type === 'tool.call.completed') {
      const id = readString(data.tool_call_id);
      if (id === undefined) continue;
      messages.push(
        withEventRunId(
          {
            role: 'tool',
            tool_call_id: id,
            content: readString(data.result) ?? '',
            timestamp: event.ts,
          },
          data,
        ),
      );
      messageSeqs.push(event.seq);
      lastAssistant = undefined;
      continue;
    }
    if (event.type === 'tool.call.failed') {
      const id = readString(data.tool_call_id);
      if (id === undefined) continue;
      const content =
        readString(data.content) ?? `Error: ${readString(data.error) ?? 'tool call failed'}`;
      messages.push(
        withEventRunId(
          {
            role: 'tool',
            tool_call_id: id,
            content,
            timestamp: event.ts,
          },
          data,
        ),
      );
      messageSeqs.push(event.seq);
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

  cursor.lastAssistant = lastAssistant;
  // 两条数组必须等长：漏记一处 seq 会让后续的「按区间读回」整体错位（错位比缺 seq 更糟）。
  // 短了补空位（`undefined` = 这条消息追不到 seq），长了截掉。
  if (messageSeqs.length !== messages.length) messageSeqs.length = messages.length;
  // 切点落在一对「response / 它的 started」之间时，回填那条 assistant 的实参
  // —— 整份投影的预扫描本来就会覆盖它，这里让分段折叠与它逐条相同。
  for (const id of startedHere) {
    if (emittedHere.has(id)) continue;
    backfillToolCallStarts(messages, id, toolStarts.get(id));
  }
  // 消息身份（additive）：`run_id` 上面已按事件补齐，段序在这里统一补 —— 与落盘漏斗
  // （`RunJournal.saveSessionState`）**同一个函数、同一个口径**，两条重建路径才认得出
  // 同一段正文。旧事件没有 `run_id` 时这两个字段保持缺省（消费端退回内容比较）。
  //
  // 增量续算也照跑：`assignMessageIdentities` 幂等（已盖章的只抬水位），对「上一段
  // 已经盖过章的消息 + 本段新消息」跑一遍，结果与整份重投影后跑一遍逐条相同。
  assignMessageIdentities(cursor.messages);
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

/**
 * 给一批消息补上「它由哪条事件产出」的 seq（0.56 ctx-recall）。
 *
 * 输入的三份东西口径不同，对齐**只能按内容**：
 * - `target`：调用方手里的那份（窗口 / `SessionState.messages` / 对账后的历史）。
 *   它是缓存对象或 `structuredClone` 出来的副本 ⇒ **对象身份对不上**，只能按签名对；
 * - `projected`：游标里的投影消息（顺序 = 事件顺序）；
 * - `seqs`：与 `projected` 逐位对齐的 seq 记录（`ProjectionCursor.messageSeqs`）。
 *
 * 对齐规则与 `coverageCut` 同口径：两条指针都只前进，同签名的重复消息（比如两条
 * 内容相同的工具结果）按出现顺序一一配对，不会把后一条配到前一条上。
 * 配不上的 `target` 消息得到 `undefined`（缓存独有的基底 system / 运行时提示行，
 * 它们本来就不是事件投影的产物）——**不许猜**一个相邻 seq：错位的区间读出来是别人的历史。
 *
 * 返回值与 `target` 等长、逐位对齐。纯函数，不读盘。
 */
export function alignMessageSeqs(
  target: readonly Message[],
  projected: readonly Message[],
  seqs: readonly (number | undefined)[],
): (number | undefined)[] {
  const positions = new Map<string, number[]>();
  for (let index = 0; index < projected.length; index += 1) {
    const message = projected[index];
    if (message === undefined) continue;
    const signature = messageSignature(message);
    const list = positions.get(signature);
    if (list === undefined) positions.set(signature, [index]);
    else list.push(index);
  }
  /** 每个签名已经用掉到第几个候选（单调前进，避免同签名消息互相抢占）。 */
  const used = new Map<string, number>();
  const aligned: (number | undefined)[] = [];
  let searchFrom = 0;
  for (const message of target) {
    const signature = messageSignature(message);
    const list = positions.get(signature);
    if (list === undefined) {
      aligned.push(undefined);
      continue;
    }
    let pointer = used.get(signature) ?? 0;
    while (pointer < list.length && (list[pointer] as number) < searchFrom) pointer += 1;
    const found = pointer < list.length ? list[pointer] : undefined;
    if (found === undefined) {
      used.set(signature, pointer);
      aligned.push(undefined);
      continue;
    }
    used.set(signature, pointer + 1);
    searchFrom = found + 1;
    aligned.push(seqs[found]);
  }
  return aligned;
}

/**
 * 消息内容签名（忽略 timestamp：事件时间与上下文写入时间会有毫秒差）。
 *
 * **也忽略 `run_id` / `run_segment`**（0.51）：那是身份不是内容。旧缓存可能没有它们、
 * 新投影有（或反之），把身份折进签名会让「缓存 ⟺ 投影」的尾部重叠匹配整体失配 ——
 * 后果是同一段历史被追加两遍，比丢了身份更糟。
 */
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
 * 「会话壳里的缓存」⇄「事件日志的纯投影」对账（0.54 B3）。
 *
 * **这条函数不许读会话壳里的任何游标字段**（`derived_upto_seq` / `projection_cache_seq`
 * 都不许）。为什么：那个数一旦参与判定，它就从「缓存覆盖到哪的提示」变回「事实水位」，
 * 于是「壳落后于日志」时整段尾部事实对人不可见（P7：`derived=4 < last_seq=366` ⇒ 刷新
 * 只剩 4 条），「壳说覆盖到 1e7」时撤回/压缩就不再生效。判据见
 * `scripts/check-projection-cache-agnostic.ts`：把这个字段删掉 / 灌毒之后，本函数的
 * 输出必须逐字节不变。
 *
 * **为什么不是「一律用投影」**：事件日志里的载荷是**脱敏之前**的那一份
 * （`context.changed` / `tool.call.completed` 发的是 `identified`，脱敏发生在
 * `ExecutionUnit#maskForAppend`，即写上下文那一刻）。投影直接顶替缓存会把真值/未中和的
 * 同形 token 重新带回 store 与请求（`check-pii-vault` 的「历史消息逐条未改」当场红）。
 * 所以缓存在**它已经覆盖的范围内是内容权威**，日志只用于「补出缓存还没有的尾部」。
 *
 * 规则（顺序即语义）：
 *
 * 0. **替换语义先判**：投影头部是一条**缓存里没有的**压缩摘要 ⇒ 中间一定发生过压缩
 *    （压缩把历史换成一条摘要，摘要必然落在投影头部）⇒ 缓存正文作废、只留基底 system，
 *    正文全部取投影。日志里出现 `session.rewound` 时同理（撤回 = 删尾部事实，缓存里那几条
 *    必须消失）。这两条都只看**日志的形状与内容**，不看任何游标。
 * 1. **对齐点按内容算**：把缓存里每条「非缓存专属」消息在投影里按顺序找一遍（跳过投影里
 *    多出来的那条 —— 它可能是脱敏 / guardrail 改写过的同一句）。全部找到 ⇒ 覆盖到
 *    「最后一条命中位置 + 1」；有**一条**找不到 ⇒ 缓存与事实无法对齐（外来缓存 / 事件里
 *    根本没有它），此时**不动缓存**（宁可不补，也不改写已有正文：append-only 是硬约束）。
 * 2. **补尾部**：`projected.slice(cut)` 整段追加。这是 P7 的修复点：壳落后时尾部事实照旧
 *    可见，且**前缀一个字节都不变**（落盘序列因此是 append-only）。
 * 3. 缓存专属消息（基底 system / 带 `name` 的运行时提示）永远留在原位：它们不是事件投影
 *    的产物，丢了等于让用户可见的卡片在重启后消失。
 *
 * 幂等性：对「结果」再跑一遍结果不变（对齐点已到投影尾部 ⇒ 追加空段）。
 */
export function reconcileCachedProjection(
  cached: readonly Message[],
  projected: readonly Message[],
  options?: { replacementInLog?: boolean },
): Message[] {
  // 0. 替换语义：日志里有撤回、或投影头部是一条**缓存里没有的**压缩摘要 ⇒ 缓存正文作废
  //    （基底 system 除外）。只看日志与内容，不看任何游标。
  if (options?.replacementInLog === true || compactionUnseenByCache(cached, projected)) {
    return [...cached.filter(isBaseSystemMessage), ...projected];
  }
  // 1. 对齐点（内容算，不看游标）。
  const cut = coverageCut(cached, projected);
  // 2. 对不上 ⇒ 保守：不动缓存（改写已有正文等于回改历史，PII 与 append-only 都破）。
  if (cut === undefined) return [...cached];
  // 3. 补尾部（前缀逐字不变）。
  if (cut >= projected.length) return [...cached];
  return [...cached, ...projected.slice(cut)];
}

/**
 * 投影头部是不是一条**缓存里没有的**压缩摘要。
 *
 * 为什么这条能精确识别「压缩把历史换掉了」：`message.compaction` 的投影会把摘要放在
 * **最前面**（它是替换语义），所以「投影头是摘要、缓存里却没有它」只可能是「壳停在压缩
 * 之前」。反过来，缓存头与投影头对不上还有别的正当原因（壳里的种子消息从来不是事件、
 * append 侧脱敏改写过正文…）—— 那些**不是**替换，不许据此丢缓存正文。
 */
function compactionUnseenByCache(
  cached: readonly Message[],
  projected: readonly Message[],
): boolean {
  const head = projected[0];
  if (head === undefined) return false;
  if (head.role !== 'system' || head.compaction_summary !== true) return false;
  const signature = messageSignature(head);
  return !cached.some((message) => messageSignature(message) === signature);
}

/**
 * 缓存已经覆盖到投影的第几条（返回该下标；`0` = 一条都没覆盖）。
 *
 * 缓存没有可比正文（只有基底 system / 暂无历史）⇒ 返回 `0`（投影整段都是新的）。
 * 有任何一条缓存正文在投影里找不到 ⇒ 返回 `undefined`（无法对齐，调用方不许改缓存）。
 * 复杂度：签名各算一次，两个指针单调前进（O(n + m)）—— 会话可以有几万条事件。
 *
 * **带 `name` 的消息是「尽力对齐」，不是「一律跳过」**（0.56 修「落盘两份」的根）。
 *
 * 旧实现把「带 name」直接当成 `isCacheOnlyMessage` 跳过（`continue`），于是只要壳里的
 * 正文整段都带 name，就没有一条参与对齐 ⇒ 返回 0 ⇒ 调用方把**整份投影**追加到壳后面。
 * 壳里那几条（`vessel:source` 来源行 + 这一轮的输入本身）在投影里也有，结果就是同一条
 * 输入写了两遍。触发条件很窄但完全真实：
 *
 * 1. A2A 投递（`agent:<alias>`）/ async ask 答案（`ask:answer`）/ rotate 交接嘱托的输入
 *    **本身带 name**（`inputNameOf`），来源行也带 name；
 * 2. run 在**初始保存**（输入已进壳、assistant 还没有）之后被硬杀 / 超时 —— 壳就停在
 *    「全是带 name 的消息」这个形状；
 * 3. 下一次 run 的 `loadStoredHistory` 对账 ⇒ 旧实现 cut=0 ⇒ 整份投影再追加一遍。
 *
 * 判据回到「投影能不能产出它」这件事本身：带 name 的消息**也可能**是投影产物
 * （`user.message` / `message.injected` 的事件载荷本来就带 name），所以先在投影里找；
 * 只在**找不到**时才按缓存专属跳过（`appendNoticeToSnapshot` 那类不落事件的提示）。
 * 找不到的**不具名正文**仍然返回 `undefined`（保守：无法对齐就不动缓存）。
 */
function coverageCut(
  cached: readonly Message[],
  projected: readonly Message[],
): number | undefined {
  const projectedSignatures = projected.map((message) => messageSignature(message));
  const cursorBySignature = new Map<string, number[]>();
  for (let index = 0; index < projectedSignatures.length; index += 1) {
    const signature = projectedSignatures[index];
    if (signature === undefined) continue;
    const list = cursorBySignature.get(signature);
    if (list === undefined) cursorBySignature.set(signature, [index]);
    else list.push(index);
  }
  let covered = 0;
  let searchFrom = 0;
  let matched = false;
  for (const message of cached) {
    // 基底 system prompt 是缓存独有的（投影永不产出）：它不占投影位置，直接跳过。
    if (isBaseSystemMessage(message)) continue;
    const positions = cursorBySignature.get(messageSignature(message));
    // 从当前位置往后找第一条还没用过的同签名投影消息（顺序对齐，不回头）。
    let found: number | undefined;
    for (const position of positions ?? []) {
      if (position < searchFrom) continue;
      found = position;
      break;
    }
    if (found === undefined) {
      // 投影里有它 ⇒ 上面已经对齐；这里只剩「投影里没有」两种情况：
      // - 带 name 的运行时提示（`appendNoticeToSnapshot` 不落事件）：缓存专属，跳过；
      // - 不具名正文：对齐不了，交给调用方保守处理（不动缓存）。
      if (isCacheOnlyMessage(message)) continue;
      return undefined;
    }
    covered = found + 1;
    searchFrom = found + 1;
    matched = true;
  }
  return matched ? covered : 0;
}

/** 基底 system prompt（非压缩摘要）：事件投影永远产不出它。 */
function isBaseSystemMessage(message: Message): boolean {
  return message.role === 'system' && message.compaction_summary !== true;
}

/**
 * 这条消息是不是**只可能来自缓存**（事件投影永远产不出来）。
 *
 * 两类，都是 `projectMessages` 的产物集之外的：
 * - 基底 system prompt（压缩摘要不算：那是 `message.compaction` 事件的投影）；
 * - 带 `name` 的运行时提示行（`vessel:notice` 环境卡 / limit / source / hook / subscription）。
 *
 * 只在对齐**找不到**时被 `coverageCut` 查询：「带 name」不足以证明它不来自事件
 * （`user.message` / `message.injected` 的载荷本来就带 name），必须先按内容找一遍。
 */
function isCacheOnlyMessage(message: Message): boolean {
  if (isBaseSystemMessage(message)) return true;
  return message.role !== 'system' && message.name !== undefined && message.name.length > 0;
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
 *
 * @deprecated 0.54 B3：读路径已改用 [`reconcileCachedProjection`]（它不依赖任何游标
 * 字段、且壳落后时以日志为准）。本函数保留只为不破坏已发布的导出；新代码不要用。
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
