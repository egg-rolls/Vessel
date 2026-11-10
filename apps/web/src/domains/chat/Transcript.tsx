import { Fragment, type ReactNode, useMemo } from 'react';
import { Markdown } from '../../components/Markdown';
import { type MessageAction, MessageActions, useMessageCopy } from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { runtimeMessageKind } from '../../state/runtime-visibility';
import type { Verbosity } from '../../state/visibility';
import { AgentMessageCard, agentMessageSender } from './AgentMessageCard';
import { historyToolVisible } from './chat-visibility';
import { HistoryToolCard } from './HistoryToolCard';
import { buildHistoryToolItems, type HistoryToolItem } from './history-tools';
import {
  orderTimelineEntries,
  type TimelineEntry,
  type TimelineLiveInput,
  type TimelineMessageInput,
} from './timeline-order';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function MessageTime({ message, block = false }: { message: Message; block?: boolean }) {
  const clock = formatClock(message.timestamp);
  if (!clock) return null;
  return (
    <time
      className={`font-mono text-2xs tabular-nums text-faint${block ? ' mt-1 block text-right' : ''}`}
      dateTime={new Date(message.timestamp ?? 0).toISOString()}
    >
      {clock}
    </time>
  );
}

/**
 * 这条历史消息是否会产生任何输出。
 *
 * 与  内部的分支共用同一判定：隐藏的条目既不该渲染，
 * 也不该产生一个空的日分组头（工具消息在 minimal 下就是这种情况）。
 */
function messageRenders(message: Message, verbosity: Verbosity): boolean {
  if (message.role === 'system') return false;
  // 落盘的 tool 消息不带状态，按 done 处理（失败信息由失败 run 的 notice 承担）。
  // 与 live 共用 historyToolVisible：不能「运行中藏、落盘后冒出来」。
  if (message.role === 'tool') return historyToolVisible('done', verbosity);
  return true;
}

function TranscriptMessage({
  message,
  messageIndex,
  previousUser,
  verbosity,
  cardsDefaultOpen,
  toolByCallId,
  onCopy,
  onEdit,
  onRetry,
}: {
  message: Message;
  /** 该消息在 `sessions.get` 的 `session.messages` 里的下标；缺失时不提供撤回。 */
  messageIndex: number | undefined;
  /** 该助手消息前一条真实用户输入及其在 `session.messages` 里的下标。 */
  previousUser?: { text: string; index: number };
  /** 可见性档位：工具消息与 live 共用同一判定（chat-visibility）。 */
  verbosity: Verbosity;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）。 */
  cardsDefaultOpen: boolean;
  /** 历史工具卡（按 call id 索引）：tool 消息与缺失结果的调用共用同一份配对结果。 */
  toolByCallId: ReadonlyMap<string, HistoryToolItem>;
  onCopy: (text: string) => void;
  onEdit: (keepMessages: number, text: string) => void;
  onRetry: (keepMessages: number, text: string) => void;
}) {
  if (!messageRenders(message, verbosity)) return null;

  if (message.role === 'tool') {
    // 历史工具消息：与运行态同一张 StreamCard（配对结果由 Transcript 预计算）。
    // 找不到配对（历史从中间开始）时用孤立结果兜底，输出绝不丢、也不渲染成 pre 看板。
    const callId =
      typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
        ? message.tool_call_id
        : undefined;
    const paired = callId === undefined ? undefined : toolByCallId.get(callId);
    const item = paired ?? buildHistoryToolItems([message])[0];
    if (item === undefined) return null;
    return <HistoryToolCard item={item} defaultOpen={cardsDefaultOpen} />;
  }

  if (message.role === 'user') {
    // A2A 投递：runtime 给这条输入写了 `agent:<alias>`，渲染成系统消息样的 agent 卡，
    // 而不是「用户自己说的话」。没有 name 的历史消息继续走下面的用户气泡。
    const agentSender = agentMessageSender(message);
    if (agentSender !== undefined) {
      return (
        <AgentMessageCard message={message} sender={agentSender} defaultOpen={cardsDefaultOpen} />
      );
    }
    const actions: MessageAction[] = [];
    if (message.content.trim().length > 0) {
      actions.push({
        id: 'copy',
        label: t('chat.message.copy'),
        onSelect: () => onCopy(message.content),
      });
      // 撤回必须用 `sessions.get` 的完整消息下标，不能用可见窗口下标。
      if (messageIndex !== undefined) {
        actions.push({
          id: 'edit',
          label: t('chat.message.edit'),
          onSelect: () => onEdit(messageIndex, message.content),
        });
      }
    }
    return (
      <div className="msg-user group flex max-w-full flex-col items-end gap-1">
        <div className="msg-bubble">
          {message.content}
          <MessageTime message={message} block />
        </div>
        {actions.length > 0 && <MessageActions className="justify-end" actions={actions} />}
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  const actions: MessageAction[] = [];
  if (message.content.trim().length > 0) {
    actions.push({
      id: 'copy',
      label: t('chat.message.copy'),
      onSelect: () => onCopy(message.content),
    });
  }
  // 中间轮次的 assistant 消息带 tool_calls；重试只给最终答复，避免一轮出现多个重试。
  if (calls.length === 0 && previousUser !== undefined && previousUser.text.trim().length > 0) {
    actions.push({
      id: 'retry',
      label: t('chat.message.retry'),
      onSelect: () => onRetry(previousUser.index, previousUser.text),
    });
  }
  return (
    <div className="msg-assistant group max-w-full">
      <div className="flex flex-wrap items-baseline gap-2">
        <div className="mb-1.5 block font-mono text-2xs tracking-widest uppercase text-faint">
          {t('chat.role.assistant')}
        </div>
        <MessageTime message={message} />
      </div>
      {message.content && <Markdown className="msg-text" text={message.content} />}
      {calls.map((call) => {
        // 结果已落盘时，卡片渲染在 role:'tool' 消息的位置（避免同一调用出现两张卡）；
        // 只有「有调用、无结果」才在这里补一张（历史被截断时的唯一可见锚点）。
        const item = toolByCallId.get(call.id);
        if (item !== undefined && item.paired) return null;
        return (
          <div className="mt-2" key={call.id}>
            {item !== undefined ? (
              <HistoryToolCard item={item} defaultOpen={cardsDefaultOpen} />
            ) : (
              <div className="flex flex-wrap items-baseline gap-2 rounded-md bg-sunken px-3 py-2 text-sm">
                <span className="font-mono text-md">{call.function.name}</span>
                <span className="text-muted">{truncate(call.function.arguments || '', 120)}</span>
              </div>
            )}
          </div>
        );
      })}
      {actions.length > 0 && <MessageActions className="mt-1" actions={actions} />}
    </div>
  );
}

/**
 * 找该助手消息前一条真实用户输入及其绝对下标。`allMessages` 是 `sessions.get`
 * 已加载的连续窗口（跨本地窗口回溯），`indexOffset` 是该窗口首条消息在完整
 * `state.messages` 里的绝对下标（CONTRACT-msg-system §4.3）；返回的下标直接作为
 * `keep_messages`。runtime 上下文消息（`vessel:*`）不是用户输入，跳过。
 */
function previousUserMessage(
  message: Message,
  allMessages: readonly Message[] | undefined,
  indexOffset: number,
): { text: string; index: number } | undefined {
  if (message.role !== 'assistant' || !allMessages) return undefined;
  const currentIndex = allMessages.indexOf(message);
  if (currentIndex < 0) return undefined;
  for (let cursor = currentIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = allMessages[cursor];
    if (candidate?.role !== 'user') continue;
    if (runtimeMessageKind(candidate) !== undefined) continue;
    return { text: candidate.content, index: cursor + indexOffset };
  }
  return undefined;
}

/** live 节点：key -> 已渲染内容。排序由 timeline-order.ts 决定。 */
export type TranscriptLiveNodes = ReadonlyMap<string, ReactNode>;

const EMPTY_LIVE_NODES: TranscriptLiveNodes = new Map();

/** 合并后的条目 → 渲染序列；日分组头按合并后的时间戳插入。 */
function renderEntries({
  entries,
  messages,
  liveNodes,
  messageIndexOffset,
  allMessages,
  verbosity,
  cardsDefaultOpen,
  toolByCallId,
  onCopy,
  onEdit,
  onRetry,
}: {
  entries: readonly TimelineEntry[];
  messages: readonly Message[];
  liveNodes: TranscriptLiveNodes;
  messageIndexOffset: number;
  allMessages: readonly Message[] | undefined;
  verbosity: Verbosity;
  cardsDefaultOpen: boolean;
  toolByCallId: ReadonlyMap<string, HistoryToolItem>;
  onCopy: (text: string) => void;
  onEdit: (keepMessages: number, text: string) => void;
  onRetry: (keepMessages: number, text: string) => void;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const entry of entries) {
    if (entry.kind === 'message') {
      const message = entry.messageIndex === undefined ? undefined : messages[entry.messageIndex];
      if (message === undefined) continue;
      // 隐藏的条目连「日分组头」也不产生，否则会出现只有分隔线的空日期。
      if (!messageRenders(message, verbosity)) continue;
    } else if (!liveNodes.has(entry.key)) {
      continue;
    }
    const day = entry.ts !== undefined ? localDayKey(entry.ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="mt-3.5 mb-2.5 flex items-center justify-center gap-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-faint"
          key={`day-${day}`}
        >
          <span>{localDayLabel(entry.ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (entry.kind === 'message') {
      const message = entry.messageIndex === undefined ? undefined : messages[entry.messageIndex];
      if (message === undefined) continue;
      // 撤回下标只认 sessions.get 加载的窗口 + 绝对偏移；对象不在其中时不提供撤回。
      const sourceIndex = allMessages?.indexOf(message);
      const messageIndex =
        sourceIndex !== undefined && sourceIndex >= 0
          ? sourceIndex + messageIndexOffset
          : undefined;
      nodes.push(
        <TranscriptMessage
          key={entry.key}
          message={message}
          messageIndex={messageIndex}
          verbosity={verbosity}
          cardsDefaultOpen={cardsDefaultOpen}
          toolByCallId={toolByCallId}
          previousUser={previousUserMessage(message, allMessages, messageIndexOffset)}
          onCopy={onCopy}
          onEdit={onEdit}
          onRetry={onRetry}
        />,
      );
      continue;
    }
    const node = liveNodes.get(entry.key);
    if (node === undefined) continue;
    nodes.push(<Fragment key={entry.key}>{node}</Fragment>);
  }
  return nodes;
}

export function Transcript({
  messages,
  allMessages,
  startIndex,
  messageIndexOffset = 0,
  live = [],
  liveNodes,
  windowStartTs,
  verbosity = 'normal',
  cardsDefaultOpen = false,
  onEditMessage,
  onRetryMessage,
}: {
  messages: Message[];
  /** 已加载的完整消息窗口（未做可见性过滤），用于回溯窗口外的前一条用户输入。 */
  allMessages?: readonly Message[];
  /** 窗口在完整可见消息里的起始下标，用于稳定 key。 */
  startIndex: number;
  /** allMessages[0] 在完整 state.messages 里的绝对下标（detailWindow.start）。 */
  messageIndexOffset?: number;
  /** 实时节点入参（真实 run / 排队 notice / 伪 run 组），排序交给 timeline-order。 */
  live?: readonly TimelineLiveInput[];
  /** 实时节点的 key -> 渲染内容；缺省视为只有历史消息。 */
  liveNodes?: TranscriptLiveNodes;
  /** 可见窗口首条消息的 ts：比它更早的 live 节点落到末尾。 */
  windowStartTs?: number;
  /** 可见性档位：历史工具消息与 live 共用同一判定（chat-visibility）。 */
  verbosity?: Verbosity;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  cardsDefaultOpen?: boolean;
  /** 编辑 = 确认后删除该消息及其后历史，并把原文写回 Composer。 */
  onEditMessage: (keepMessages: number, text: string) => void;
  /** 重试 = 确认后删除该回复及其后历史，并重新发送前一条用户内容。 */
  onRetryMessage: (keepMessages: number, text: string) => void;
}) {
  const copy = useMessageCopy();
  const nodes = liveNodes ?? EMPTY_LIVE_NODES;
  if (messages.length === 0 && live.length === 0) return null;

  // 历史消息 → 排序入参。key 用绝对消息下标（detailWindow.start + 窗口内下标）：
  // 游标分页前插一页时窗口相对下标会整体平移，用它会把所有历史消息 remount 一次。
  const messageInputs: TimelineMessageInput[] = messages.map((message, index) => {
    const sourceIndex = allMessages?.indexOf(message);
    const absolute =
      sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex + messageIndexOffset : undefined;
    return {
      key: `m-${absolute ?? startIndex + index}`,
      role: message.role,
      content: message.content,
      runtimeContext: runtimeMessageKind(message) !== undefined,
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    };
  });

  // 历史工具配对只算一次：tool 消息与「有调用无结果」共用同一份结果，避免同一调用出现两张卡。
  const historyTools = useMemo(
    () => buildHistoryToolItems(allMessages ?? messages),
    [allMessages, messages],
  );
  const toolByCallId = useMemo(() => {
    const map = new Map<string, HistoryToolItem>();
    for (const item of historyTools) {
      if (item.callId !== undefined) map.set(item.callId, item);
    }
    return map;
  }, [historyTools]);

  const entries = orderTimelineEntries({ messages: messageInputs, live, windowStartTs });

  return (
    <div className="flex flex-col gap-4 py-1.5 pb-2.5">
      {renderEntries({
        entries,
        messages,
        liveNodes: nodes,
        messageIndexOffset,
        allMessages,
        verbosity,
        cardsDefaultOpen,
        toolByCallId,
        onCopy: copy,
        onEdit: onEditMessage,
        onRetry: onRetryMessage,
      })}
    </div>
  );
}
