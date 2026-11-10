/**
 * 时间线的**单一 item 流**（纯函数，无 React / DOM）。
 *
 * 渲染不再分「运行态」与「终止态」两条路径：事件流和 sessions.get 都只是 item 的来源，
 * 同一个逻辑对象在两边都存在时是**同一个 item**（身份靠 key，不靠状态推断）。
 * 工具运行→结束只改 item 的字段，不产生新 item、不重挂。
 *
 * 身份命名：
 * - msg:<绝对下标>            历史消息（绝对下标 = detailWindow.start + 窗口内下标，前插不变）
 * - run:<runId>:text:<n>      一次 run 的第 n 段正文（尾部未闭合段与 flush 后是同一个 n）
 * - run:<runId>:reasoning:<n> 第 n 段思考
 * - tool:<callId>             工具调用（live 与 history 共用；无 callId 时 tool:run:<runId>:<key>）
 * - tool:orphan:<绝对下标>     只有结果、没有调用的历史 tool 消息
 * - notice:<item.key>         上下文 / 原始事件行
 * - queued:<runId>            本地排队提交
 *
 * 去重 = **认领（claiming）**：按轮次顺序一对一匹配，每个 run 最多认领一条用户消息，
 * 每条消息最多被一个 run 认领；被认领的历史消息不再单独成 item（run 是权威来源）。
 * 认领失败（guardrail 改写过正文等）时两边都渲染 —— 宁可重复，绝不吞消息。
 */
import type { Message, RunEvent } from '../../gateway/types';
import type { RunGroup } from '../../state/events';
import { buildHistoryToolItems } from './history-tools';
import { compareTimelineEntries } from './timeline-order';
import { foldToolItems, type ToolCardStatus } from './tool-cards';

export type TranscriptSpeaker = 'user' | 'assistant' | string;

/** 排序与分组共用的信封字段。 */
interface ItemMeta {
  key: string;
  /** 排序用的权威时间（可被窗口夹取掉）。 */
  ts?: number;
  /** 同 ts 的稳定回退（该 run 的首个 wire seq）。 */
  seq?: number;
  /** 连续同发言人：本条是否是这一段的开头；非消息类没有这个字段。 */
  speaker?: TranscriptSpeaker;
  groupStart?: boolean;
}

export interface MessageItem extends ItemMeta {
  kind: 'message';
  absIndex: number;
  message: Message;
  /**
   * A2A 来源地址：从紧邻的 vessel:source 消息吸进来的。
   * 来源行不再单独成行，改为挂在这张 agent 卡的 meta 上。
   */
  sourceText?: string;
}

export interface RunInputItem extends ItemMeta {
  kind: 'run-input';
  runId: string;
  text: string;
}

export interface RunTextItem extends ItemMeta {
  kind: 'run-text';
  runId: string;
  text: string;
  /** 这段正文是否仍在流式（决定 Markdown vs 纯文本）。 */
  streaming: boolean;
}

export interface RunReasoningItem extends ItemMeta {
  kind: 'run-reasoning';
  runId: string;
  text: string;
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface ToolItem extends ItemMeta {
  kind: 'tool';
  callId?: string;
  name: string;
  args?: unknown;
  output?: unknown;
  status: ToolCardStatus;
  /** live 侧来自哪个 run（历史工具无 runId）。 */
  runId?: string;
  error?: string;
  durationMs?: number;
  truncated?: boolean;
  startedAt: number;
  /** false = 有调用无结果 / 孤立结果（渲染 outputMissing）。 */
  paired: boolean;
}

export interface NoticeItem extends ItemMeta {
  kind: 'notice';
  event: RunEvent;
}

export interface QueuedItem extends ItemMeta {
  kind: 'queued';
  runId: string;
  input: string;
  submittedAt: number;
  queuePosition?: number;
  cancelling: boolean;
  cancelled: boolean;
}

export type TranscriptItem =
  | MessageItem
  | RunInputItem
  | RunTextItem
  | RunReasoningItem
  | ToolItem
  | NoticeItem
  | QueuedItem;

/** 一次 build 的输入。historyIndex / liveItems 由调用侧 memo 后传入（见文件头性能说明）。 */
export interface TranscriptBuildInput {
  /** 已加载的历史窗口（按消息顺序）。 */
  messages: readonly Message[];
  /** messages[0] 在完整 state.messages 里的绝对下标。 */
  messageIndexOffset: number;
  /** 事件缓冲里的 run 分组（可含未落盘的）。 */
  liveGroups: readonly RunGroup[];
  /** 本地排队提交（乐观）。 */
  queued: readonly QueuedInput[];
  /** 可见窗口首条消息的 ts：更早的 live item 落到末尾。 */
  windowStartTs?: number;
  /** 历史消息是否应被隐藏（runtime 上下文可见性开关）；隐藏的仍参与下标与认领。 */
  isHidden?: (message: Message) => boolean;
  /** 预计算的历史索引（按 messages 引用 memo）；缺省内部现算。 */
  historyIndex?: HistoryIndex;
  /** 预计算的 live item（按 group 引用 memo）；缺省内部现算。 */
  liveItems?: readonly TranscriptItem[];
}

/** 排队提交的最小形状（与 StreamItems 的 QueuedSubmission 对齐，避免循环依赖）。 */
export interface QueuedInput {
  runId: string;
  input: string;
  submittedAt: number;
  queuePosition?: number;
  cancelling: boolean;
  cancelled: boolean;
}

/** 历史侧索引：item 与「认领」用的反查表。 */
export interface HistoryIndex {
  /** 历史消息 item（不含被历史内部配对消耗掉的 tool 消息）。 */
  items: TranscriptItem[];
  /** 用户消息：内容 → 绝对下标（升序）。 */
  userByContent: Map<string, number[]>;
  /** 绝对下标 → 该消息里的 tool_call id 集合（assistant）。 */
  callIdsByIndex: Map<number, string[]>;
  /** 绝对下标 → 正文（assistant，用于和 run 输出比对）。 */
  contentByIndex: Map<number, string>;
  /** 绝对下标 → 消息（认领时回读）。 */
  messageByIndex: Map<number, Message>;
  /** 历史里出现过的 tool_call id（判断 run 是否已落盘）。 */
  callIds: Set<string>;
}

function trimText(value: string | undefined): string {
  return (value ?? '').trim();
}

/** A2A 来源行的消息名（与 runtimeMessageKind 的 source 种类一致）。 */
export const SOURCE_MESSAGE_NAME = 'vessel:source';

/** 从来源行正文取地址：location="a@node:team" → a@node:team。 */
export function sourceLocationOf(content: string): string | undefined {
  const match = /location="([^"]+)"/.exec(content);
  const value = match?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 这条消息是否 A2A 来源行。 */
function isSourceMessage(message: Message): boolean {
  return message.name === SOURCE_MESSAGE_NAME;
}

/** 这条消息是否 agent 发来的（agent:<alias>）。 */
function isAgentNamed(message: Message): boolean {
  return typeof message.name === 'string' && message.name.startsWith('agent:');
}

/** 历史窗口 → item + 反查表（只依赖 messages 与 offset，调用侧可安全 memo）。 */
export function buildHistoryIndex(
  messages: readonly Message[],
  messageIndexOffset: number,
  isHidden?: (message: Message) => boolean,
): HistoryIndex {
  const items: TranscriptItem[] = [];
  const userByContent = new Map<string, number[]>();
  const callIdsByIndex = new Map<number, string[]>();
  const contentByIndex = new Map<number, string>();
  const messageByIndex = new Map<number, Message>();
  const callIds = new Set<string>();

  // 可见性：隐藏的消息**不产生 item**，但仍要进 messageByIndex / contentByIndex
  // （绝对下标、认领、previous-user 都依赖它们）。
  const hidden = new Set<number>();
  if (isHidden !== undefined) {
    messages.forEach((message, index) => {
      if (isHidden(message)) hidden.add(messageIndexOffset + index);
    });
  }

  // A2A 来源行折叠：vessel:source 之后「下一条可见消息」是 agent 消息时，来源行不再
  // 单独成行，地址吸进那张 agent 卡（见 MessageItem.sourceText）。从后往前扫，O(n)。
  const foldedSourceByAgent = new Map<number, string>();
  const foldedSourceIndexes = new Set<number>();
  let nextVisible: { absIndex: number; message: Message } | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const absIndex = messageIndexOffset + index;
    const isHiddenMessage = hidden.has(absIndex);
    // 来源行的折叠与它自己是否可见无关：可见性只决定「不被吸收时它是否单独成行」，
    // 地址始终挂到后面那张 agent 卡上（用户要的是别丢信息，而不是别显示）。
    if (isSourceMessage(message)) {
      if (nextVisible !== undefined && isAgentNamed(nextVisible.message)) {
        const location = sourceLocationOf(message.content);
        if (location !== undefined) foldedSourceByAgent.set(nextVisible.absIndex, location);
        foldedSourceIndexes.add(absIndex);
        continue;
      }
      if (!isHiddenMessage) nextVisible = { absIndex, message };
      continue;
    }
    if (isHiddenMessage) continue;
    nextVisible = { absIndex, message };
  }

  // 历史工具消息：与 assistant 的 tool_calls 配对后各自成 item（tool:<callId>）。
  const historyTools = buildHistoryToolItems(messages);
  const toolByCallId = new Map<string, (typeof historyTools)[number]>();
  const orphanTools: { item: (typeof historyTools)[number]; index: number }[] = [];
  for (const tool of historyTools) {
    if (tool.callId !== undefined) {
      toolByCallId.set(tool.callId, tool);
      callIds.add(tool.callId);
    }
  }

  messages.forEach((message, index) => {
    const absIndex = messageIndexOffset + index;
    // 先入索引：隐藏的消息仍要支撑绝对下标 / 认领 / previous-user 回读。
    messageByIndex.set(absIndex, message);
    if (message.role === 'system') return;
    // 隐藏（runtime 上下文按可见性开关拦掉）：不进 item，也不参与用户输入认领。
    if (hidden.has(absIndex)) return;
    // 被 agent 卡吸收的来源行：不单独成行。
    if (isSourceMessage(message) && foldedSourceIndexes.has(absIndex)) return;

    if (message.role === 'tool') {
      const callId =
        typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
          ? message.tool_call_id
          : undefined;
      const paired = callId === undefined ? undefined : toolByCallId.get(callId);
      if (paired !== undefined) {
        // 配对成功的 tool 消息由调用侧的 item 代表（下面根据 assistant 的 tool_calls 输出），
        // 这里只记录，不重复产出。
        return;
      }
      orphanTools.push({
        item: historyTools.find((tool) => tool.key === `history-tool-${index}`) ?? {
          key: `history-tool-${index}`,
          name: message.name ?? 'tool',
          output: message.content,
          status: 'neutral',
          paired: false,
        },
        index,
      });
      return;
    }

    if (message.role === 'user') {
      const text = trimText(message.content);
      const list = userByContent.get(text);
      if (list === undefined) userByContent.set(text, [absIndex]);
      else list.push(absIndex);
    }

    const ids = (message.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) callIdsByIndex.set(absIndex, ids);
    for (const id of ids) callIds.add(id);
    if (message.role === 'assistant') contentByIndex.set(absIndex, trimText(message.content));

    // 只有 tool_calls、没有正文的 assistant 消息不单独成 item（工具卡代表它）。
    const hasContent = trimText(message.content).length > 0;
    const isAgentMessage = typeof message.name === 'string' && message.name.startsWith('agent:');
    if (message.role === 'assistant' && !hasContent && ids.length > 0) return;
    if (!hasContent && message.role !== 'user' && !isAgentMessage) return;

    const sourceText = foldedSourceByAgent.get(absIndex);
    items.push({
      kind: 'message',
      key: `msg:${absIndex}`,
      absIndex,
      message,
      ...(sourceText !== undefined ? { sourceText } : {}),
      ...(message.timestamp !== undefined ? { ts: message.timestamp } : {}),
    });
  });

  // 历史工具 item：优先挂在「发起调用的 assistant 消息」位置（ts 用它的 timestamp）。
  for (const [absIndex, ids] of callIdsByIndex) {
    const message = messageByIndex.get(absIndex);
    for (const callId of ids) {
      const tool = toolByCallId.get(callId);
      if (tool === undefined) continue;
      items.push({
        kind: 'tool',
        key: `tool:${callId}`,
        callId,
        name: tool.name,
        ...(tool.args !== undefined ? { args: tool.args } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        status: 'done',
        startedAt: message?.timestamp ?? 0,
        paired: tool.paired,
        ...(message?.timestamp !== undefined ? { ts: message.timestamp } : {}),
      });
    }
  }
  for (const { item, index } of orphanTools) {
    const absIndex = messageIndexOffset + index;
    items.push({
      kind: 'tool',
      key: `tool:orphan:${absIndex}`,
      name: item.name,
      ...(item.output !== undefined ? { output: item.output } : {}),
      status: 'done',
      startedAt: messageByIndex.get(absIndex)?.timestamp ?? 0,
      paired: false,
      ...(messageByIndex.get(absIndex)?.timestamp !== undefined
        ? { ts: messageByIndex.get(absIndex)?.timestamp }
        : {}),
    });
  }

  return { items, userByContent, callIdsByIndex, contentByIndex, messageByIndex, callIds };
}

/** run 分组 → live item（只依赖 group 对象，未变化的 group 可被调用侧 memo 命中）。 */
export function buildLiveItems(groups: readonly RunGroup[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const group of groups) {
    const baseTs = group.startedAt ?? group.firstTs;
    const meta = {
      ...(baseTs !== undefined ? { ts: baseTs } : {}),
      ...(group.firstSeq !== undefined ? { seq: group.firstSeq } : {}),
    };
    // run 的用户输入：历史里还没落盘时由它显示气泡；被历史消息认领后由 assemble 丢掉。
    if (trimText(group.input).length > 0) {
      items.push({
        kind: 'run-input',
        key: `run:${group.runId}:input`,
        runId: group.runId,
        text: group.input as string,
        ...meta,
      });
    }
    let textIndex = 0;
    let reasoningIndex = 0;
    for (const item of foldToolItems(group.items)) {
      if (item.kind === 'text') {
        items.push({
          kind: 'run-text',
          key: `run:${group.runId}:text:${textIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
          ...meta,
        });
        textIndex += 1;
        continue;
      }
      if (item.kind === 'reasoning') {
        items.push({
          kind: 'run-reasoning',
          key: `run:${group.runId}:reasoning:${reasoningIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
          ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
          ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
          ...meta,
        });
        reasoningIndex += 1;
        continue;
      }
      if (item.kind === 'tool') {
        items.push({
          kind: 'tool',
          key:
            item.callId !== undefined
              ? `tool:${item.callId}`
              : `tool:run:${group.runId}:${item.key}`,
          ...(item.callId !== undefined ? { callId: item.callId } : {}),
          runId: group.runId,
          name: item.name,
          ...(item.args !== undefined ? { args: item.args } : {}),
          ...(item.result !== undefined ? { output: item.result } : {}),
          status: item.status,
          ...(item.error !== undefined ? { error: item.error } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          ...(item.truncated === true ? { truncated: true } : {}),
          startedAt: item.startedAt,
          paired: item.status !== 'running',
          ...meta,
        });
        continue;
      }
      // notice / 原始事件：逐条一个 item，不参与分组。
      items.push({
        kind: 'notice',
        key: `notice:${item.key}`,
        event: item.event,
        ts: item.event.ts,
        ...(group.firstSeq !== undefined ? { seq: group.firstSeq } : {}),
      });
    }
    // 尾部未闭合段用**当前段序**做 key：flush 之后它就是同一个 n（身份延续的关键）。
    if (group.liveText !== undefined && group.liveText.length > 0) {
      items.push({
        kind: 'run-text',
        key: `run:${group.runId}:text:${textIndex}`,
        runId: group.runId,
        text: group.liveText,
        streaming: true,
        ...meta,
      });
    }
    if (group.liveReasoning !== undefined && group.liveReasoning.length > 0) {
      items.push({
        kind: 'run-reasoning',
        key: `run:${group.runId}:reasoning:${reasoningIndex}`,
        runId: group.runId,
        text: group.liveReasoning,
        streaming: true,
        ...meta,
      });
    }
  }
  return items;
}

/** run 侧认领所需的信息（callId 集合、已流出的正文、用户输入）。 */
interface RunClaim {
  runId: string;
  input: string;
  output: string;
  running: boolean;
  startTs?: number;
  callIds: Set<string>;
}

function runClaims(groups: readonly RunGroup[], live: readonly TranscriptItem[]): RunClaim[] {
  const byRun = new Map<string, RunClaim>();
  for (const group of groups) {
    byRun.set(group.runId, {
      runId: group.runId,
      input: trimText(group.input),
      output: trimText(group.output),
      running: group.status === 'running',
      ...((group.startedAt ?? group.firstTs) !== undefined
        ? { startTs: group.startedAt ?? group.firstTs }
        : {}),
      callIds: new Set<string>(),
    });
  }
  for (const item of live) {
    if (item.kind === 'tool' && item.runId !== undefined && item.callId !== undefined) {
      byRun.get(item.runId)?.callIds.add(item.callId);
    }
  }
  // 正文：run.completed.output 缺失时用已流出的正文兜底（同一段文本即可认领）。
  for (const item of live) {
    if (item.kind !== 'run-text') continue;
    const claim = byRun.get(item.runId);
    if (claim === undefined || claim.output.length > 0) continue;
    claim.output = trimText(item.text);
  }
  return [...byRun.values()].sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

/**
 * 认领：把「live 里已经有的事件」与「历史里刚出现的那条消息」对成同一个逻辑对象。
 *
 * 一对一、按轮次顺序：每个 run 最多认领一条用户消息（同一句话连发两次时按顺序取
 * 未认领的下一条），每条消息最多被一个 run 认领；assistant 消息按 callId 子集或
 * 正文相等/包含认领，允许一个 run 认领它自己的多条迭代。
 */
function claimMessages(
  claims: readonly RunClaim[],
  history: HistoryIndex,
): { claimedAssistant: Set<number>; claimedUserByRun: Map<string, number> } {
  const claimedUser = new Set<number>();
  const claimedUserByRun = new Map<string, number>();
  let cursor = -Infinity;
  for (const claim of claims) {
    if (claim.input.length === 0) continue;
    const candidates = history.userByContent.get(claim.input) ?? [];
    const target = candidates.find((index) => index >= cursor && !claimedUser.has(index));
    if (target === undefined) continue;
    claimedUser.add(target);
    claimedUserByRun.set(claim.runId, target);
    cursor = target;
  }

  const claimedAssistant = new Set<number>();
  for (const claim of claims) {
    const from = claimedUserByRun.get(claim.runId) ?? cursor;
    if (claim.output.length === 0) continue;
    for (const [absIndex, content] of history.contentByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (content !== claim.output && !(content.length >= 8 && claim.output.includes(content))) {
        continue;
      }
      claimedAssistant.add(absIndex);
    }
    for (const [absIndex, ids] of history.callIdsByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (!(ids.length > 0 && ids.every((id) => claim.callIds.has(id)))) continue;
      claimedAssistant.add(absIndex);
    }
  }
  return { claimedAssistant, claimedUserByRun };
}

/**
 * 同 key 合并（**身份的唯一实现**）：一个逻辑对象在多个来源里出现时只留一个 item。
 *
 * 工具卡：内容（name / args / output / paired）以**历史**为准（落盘值是权威），
 * 执行态（status / duration / error / startedAt）以**live** 为准；两边都有 ts 时取更早的。
 * 其它 kind：后到者覆盖（live 是最新事实）。
 */
function mergeByKey(items: readonly TranscriptItem[]): TranscriptItem[] {
  const byKey = new Map<string, TranscriptItem>();
  const order: string[] = [];
  for (const item of items) {
    const previous = byKey.get(item.key);
    if (previous === undefined) {
      byKey.set(item.key, item);
      order.push(item.key);
      continue;
    }
    byKey.set(item.key, mergeItem(previous, item));
  }
  return order
    .map((key) => byKey.get(key))
    .filter((item): item is TranscriptItem => item !== undefined);
}

function mergeItem(previous: TranscriptItem, next: TranscriptItem): TranscriptItem {
  if (previous.kind === 'tool' && next.kind === 'tool') {
    return {
      ...previous,
      ...(next.runId !== undefined ? { runId: next.runId } : {}),
      status: next.status,
      paired: previous.paired || next.paired,
      ...(previous.output !== undefined
        ? { output: previous.output }
        : next.output !== undefined
          ? { output: next.output }
          : {}),
      ...(previous.args !== undefined ? { args: previous.args } : {}),
      ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
      ...(next.error !== undefined && previous.error === undefined ? { error: next.error } : {}),
      ...(next.truncated === true ? { truncated: true } : {}),
      startedAt: next.startedAt > 0 ? next.startedAt : previous.startedAt,
      ts: previous.ts ?? next.ts,
    };
  }
  return { ...previous, ...next, key: previous.key };
}

/**
 * 单一 item 流（纯函数）。
 *
 * 复杂度：历史侧 item / 反查表由  按  引用 memo；live 侧 item
 * 由  按 group 对象 memo（未变化的 run 直接命中缓存）。每次调用只剩
 * O(认领扫描 + 合并 + 排序)，与 50ms 的流式节拍无关的重建都发生在引用变化时。
 */
export function buildTranscriptItems(input: TranscriptBuildInput): TranscriptItem[] {
  const history =
    input.historyIndex ??
    buildHistoryIndex(input.messages, input.messageIndexOffset, input.isHidden);
  const live = input.liveItems ?? buildLiveItems(input.liveGroups);
  const claims = runClaims(input.liveGroups, live);
  const { claimedAssistant, claimedUserByRun } = claimMessages(claims, history);

  const lastUserTs = (() => {
    let last: number | undefined;
    for (const [, message] of history.messageByIndex) {
      if (message.role !== 'user' || message.timestamp === undefined) continue;
      if (last === undefined || message.timestamp > last) last = message.timestamp;
    }
    return last;
  })();

  const items: TranscriptItem[] = [];
  for (const item of history.items) {
    if (item.kind === 'message' && claimedAssistant.has(item.absIndex)) continue;
    items.push(item);
  }

  const claimByRun = new Map(claims.map((claim) => [claim.runId, claim]));
  for (const item of live) {
    const runId = 'runId' in item ? item.runId : undefined;
    // 用户输入已被历史消息认领：历史那条负责渲染，run 侧气泡丢弃（绝不两个气泡）。
    if (item.kind === 'run-input' && runId !== undefined && claimedUserByRun.has(runId)) continue;
    const claim = runId === undefined ? undefined : claimByRun.get(runId);
    if (claim === undefined) {
      items.push(item);
      continue;
    }
    const claimedUser = claimedUserByRun.get(claim.runId);
    const claimedUserTs =
      claimedUser === undefined ? undefined : history.messageByIndex.get(claimedUser)?.timestamp;
    // 强下限（认领到的用户消息）总是生效：run.started 比用户消息落盘早几毫秒。
    // 弱下限（最后一条用户消息）只在 item 自己没有 ts 时兜底 —— 否则「早于可见窗口的
    // 旧 run 卡片」会被拽到新卡片后面，屏幕上时间看起来倒序（F9 守这一条）。
    const strong = claimedUserTs !== undefined ? claimedUserTs + 1 : undefined;
    const weak =
      claim.running && item.ts === undefined && lastUserTs !== undefined
        ? lastUserTs + 1
        : undefined;
    const floor = strong ?? weak;
    const base =
      floor === undefined ? item.ts : item.ts === undefined ? floor : Math.max(item.ts, floor);
    items.push({ ...item, ts: base });
  }

  for (const queued of input.queued) {
    const base = queued.submittedAt;
    items.push({
      kind: 'queued',
      key: `queued:${queued.runId}`,
      runId: queued.runId,
      input: queued.input,
      submittedAt: queued.submittedAt,
      ...(queued.queuePosition !== undefined ? { queuePosition: queued.queuePosition } : {}),
      cancelling: queued.cancelling,
      cancelled: queued.cancelled,
      ts: base,
    });
  }

  const ordered = mergeByKey(items)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareTimelineEntries(a.item, b.item, a.index, b.index))
    .map(({ item }) => item);

  return withSpeakerRuns(ordered);
}

/**
 * 连续同发言人分组：只由消息类 item 决定（历史消息 / run 正文），
 * tool / notice / reasoning / queued 既不参与也不打断（扫描时跳过）。
 */
export function withSpeakerRuns(items: readonly TranscriptItem[]): TranscriptItem[] {
  let previous: string | undefined;
  return items.map((item) => {
    const speaker = speakerOf(item);
    if (speaker === undefined) return item;
    const groupStart = speaker !== previous;
    previous = speaker;
    return { ...item, speaker, groupStart };
  });
}

function speakerOf(item: TranscriptItem): string | undefined {
  if (item.kind === 'run-text') return 'assistant';
  if (item.kind !== 'message') return undefined;
  const name = item.message.name;
  if (typeof name === 'string' && name.startsWith('agent:')) return name;
  return item.message.role;
}
