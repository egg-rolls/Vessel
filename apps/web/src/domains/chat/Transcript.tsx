import { Fragment, type ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { type MessageAction, MessageActions, useMessageCopy } from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { runtimeMessageKind } from '../../state/runtime-visibility';

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

function TranscriptMessage({
  message,
  messageIndex,
  previousUser,
  onCopy,
  onEdit,
  onRetry,
}: {
  message: Message;
  /** 该消息在 `sessions.get` 的 `session.messages` 里的下标；缺失时不提供撤回。 */
  messageIndex: number | undefined;
  /** 该助手消息前一条真实用户输入及其在 `session.messages` 里的下标。 */
  previousUser?: { text: string; index: number };
  onCopy: (text: string) => void;
  onEdit: (keepMessages: number, text: string) => void;
  onRetry: (keepMessages: number, text: string) => void;
}) {
  if (message.role === 'system') return null;

  if (message.role === 'tool') {
    const label = message.name || message.tool_call_id || 'tool';
    return (
      <div className="ml-0.5 max-w-full rounded-md bg-sunken px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="mb-1 block font-mono text-2xs tracking-wider text-muted">{label}</span>
          <MessageTime message={message} />
        </div>
        <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-sm leading-relaxed text-muted">
          {message.content}
        </pre>
      </div>
    );
  }

  if (message.role === 'user') {
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
      {calls.map((call) => (
        <div
          className="mt-2 flex flex-wrap items-baseline gap-2 rounded-md bg-sunken px-3 py-2 text-sm"
          key={call.id}
        >
          <span className="font-mono text-md">{call.function.name}</span>
          <span className="text-muted">{truncate(call.function.arguments || '', 120)}</span>
        </div>
      ))}
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

/** 时间线节点：历史消息与实时 run 项共享同一条按时间排序的列表。 */
export interface TranscriptLiveEntry {
  key: string;
  /**
   * 该节点的起始时间（run.started / 排队提交时间）。
   * 缺失时排在有时间戳的节点之后，并保持插入顺序。
   */
  ts?: number;
  /** 同 `ts` 时的稳定回退（run 的首个 wire seq）；消息节点没有 seq，退回插入序。 */
  seq?: number;
  node: ReactNode;
}

interface TimelineUnit {
  key: string;
  ts: number | undefined;
  seq: number | undefined;
  node: ReactNode;
}

/**
 * 按时间戳稳定合并节点（纯函数，便于单测）。
 *
 * 排序键是权威时间 `ts`，**不是到达顺序**；同 `ts` 先比 `seq`，再退回插入序
 * （历史消息在前、实时节点在后），避免同毫秒抖动把同一条 run 的正文/工具卡拆开。
 * 缺时间戳的节点排在有时间戳的节点之后，并彼此保持插入序（降级，不抛错）。
 */
export function orderTimeline<T extends { ts?: number | undefined; seq?: number | undefined }>(
  units: readonly T[],
): T[] {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => {
      const at = a.unit.ts;
      const bt = b.unit.ts;
      if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
      // 两边都有时间戳且相等（或都缺失）→ 用 seq 回退，再退回插入序。
      if (at === undefined && bt !== undefined) return 1;
      if (at !== undefined && bt === undefined) return -1;
      const aseq = a.unit.seq;
      const bseq = b.unit.seq;
      if (aseq !== undefined && bseq !== undefined && aseq !== bseq) return aseq - bseq;
      return a.index - b.index;
    })
    .map(({ unit }) => unit);
}

/**
 * 历史消息 + 实时 run 项 → 按时间戳合并后的节点序列。
 *
 * 0.18 起历史消息与实时展开项共用一个列表，但一直是「历史全部在前、实时整块追加在后」，
 * 于是正在跑的 run（以及不会落盘的失败 / 取消 run）的事件行永远堆在最后一条消息之后。
 * 这里按权威时间 `ts` 做稳定排序把它们插回时间线原位（同 ts 用 `seq` 回退）：
 * - 历史消息缺 `timestamp` 时沿用前一条的时间（老数据降级），不会被甩到末尾；
 * - 同一 run 的正文 / 工具卡属于同一个 live 节点，合并后不可能被拆到最后追加。
 *
 * 去重不在这里做：`sessions.get` 已提交的内容与 live 事件的重复由
 * `isGroupPersisted`（`state/events.ts`，键 = status + input + output）与
 * `hideInput`（同 key 的 input 半边）保证只渲一份。
 *
 * **已知且是预期行为**：比已加载窗口更早的 failed / cancelled run（不落盘、也没有
 * `isGroupPersisted` 能盖掉它）不会被 `sortTs` 夹取，会插回它真实的 ts 位置——也就是
 * 会出现在历史消息中间而不是末尾。这是「按 ts 排序」的正确结果，不要当 bug 改回去。
 */
function buildTimelineUnits(
  messages: Message[],
  startIndex: number,
  messageIndexOffset: number,
  allMessages: readonly Message[] | undefined,
  live: readonly TranscriptLiveEntry[],
  onCopy: (text: string) => void,
  onEdit: (keepMessages: number, text: string) => void,
  onRetry: (keepMessages: number, text: string) => void,
): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  let carry: number | undefined;
  messages.forEach((message, index) => {
    if (message.timestamp !== undefined) carry = message.timestamp;
    // 撤回下标只认 `sessions.get` 加载的窗口 + 绝对偏移；对象不在其中时不提供撤回。
    const sourceIndex = allMessages?.indexOf(message);
    const messageIndex =
      sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex + messageIndexOffset : undefined;
    units.push({
      // key 用绝对消息下标（`detailWindow.start` + 窗口内下标）：游标分页前插一页时
      // 窗口相对下标会整体平移，用它会把所有历史消息 remount 一次（展开的 details /
      // 工具卡状态被重置）；绝对下标对同一条消息恒定。
      key: `m-${messageIndex ?? startIndex + index}`,
      ts: message.timestamp ?? carry,
      seq: undefined,
      node: (
        <TranscriptMessage
          message={message}
          messageIndex={messageIndex}
          previousUser={previousUserMessage(message, allMessages, messageIndexOffset)}
          onCopy={onCopy}
          onEdit={onEdit}
          onRetry={onRetry}
        />
      ),
    });
  });
  for (const entry of live) {
    units.push({ key: entry.key, ts: entry.ts, seq: entry.seq, node: entry.node });
  }
  return orderTimeline(units);
}

/** 合并后的节点 → 渲染序列；日分组头按合并后的时间戳插入。 */
function renderTimeline(units: readonly TimelineUnit[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const unit of units) {
    const day = unit.ts !== undefined ? localDayKey(unit.ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="mt-3.5 mb-2.5 flex items-center justify-center gap-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-faint"
          key={`day-${day}`}
        >
          <span>{localDayLabel(unit.ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    nodes.push(<Fragment key={unit.key}>{unit.node}</Fragment>);
  }
  return nodes;
}

export function Transcript({
  messages,
  allMessages,
  startIndex,
  messageIndexOffset = 0,
  live = [],
  onEditMessage,
  onRetryMessage,
}: {
  messages: Message[];
  /** 已加载的完整消息窗口（未做可见性过滤），用于回溯窗口外的前一条用户输入。 */
  allMessages?: readonly Message[];
  /** 窗口在完整可见消息里的起始下标，用于稳定 key。 */
  startIndex: number;
  /** `allMessages[0]` 在完整 `state.messages` 里的绝对下标（`detailWindow.start`）。 */
  messageIndexOffset?: number;
  /** 编辑 = 确认后删除该消息及其后历史，并把原文写回 Composer。 */
  onEditMessage: (keepMessages: number, text: string) => void;
  /** 重试 = 确认后删除该回复及其后历史，并重新发送前一条用户内容。 */
  onRetryMessage: (keepMessages: number, text: string) => void;
  /** 实时 run 的展开项与排队 notice：按时间戳插进历史消息之间。 */
  live?: readonly TranscriptLiveEntry[];
}) {
  const copy = useMessageCopy();
  if (messages.length === 0 && live.length === 0) return null;
  const units = buildTimelineUnits(
    messages,
    startIndex,
    messageIndexOffset,
    allMessages,
    live,
    copy,
    onEditMessage,
    onRetryMessage,
  );
  return <div className="flex flex-col gap-4 py-1.5 pb-2.5">{renderTimeline(units)}</div>;
}
