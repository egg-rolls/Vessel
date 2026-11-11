import { Fragment, type ReactNode, useMemo } from 'react';
import { Markdown } from '../../components/Markdown';
import {
  type MessageAction,
  MessageActions,
  MessageFold,
  useMessageCopy,
} from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { runtimeMessageKind } from '../../state/runtime-visibility';
import { AgentMessageCard, agentMessageSender } from './AgentMessageCard';
import { ReasoningBlock } from './ReasoningBlock';
import type { TranscriptItem } from './transcript-items';

/**
 * 这条历史消息自己要显示的思考文本（thinking 模式的 reasoning_content）。
 *
 * 历史侧的思考**挂在消息 item 内部**渲染，不单独造 item：
 * - 不双出：被 live 认领的 assistant 消息在建 item 流时就被丢弃了（transcript-items.ts
 *   的 buildTranscriptItems 里 `claimedAssistant.has(item.absIndex)` 那次 continue），
 *   那条消息的思考由 run:<runId>:reasoning:<n> 负责；能走到这里的消息一定没有 live 来源。
 * - 不另造 item 也就不碰排序/去重：思考跟着所属消息的时间戳走，位置固定在正文上方 ——
 *   与 live 里「思考 item 排在正文 item 之前」是同一个顺序语义。
 *
 * 没有正文、也没有 tool_calls 的消息同样走这里：只渲思考块（没有空正文节点、没有空气泡）。
 */
function historyReasoning(message: Message): string | undefined {
  if (message.role !== 'assistant') return undefined;
  const text = message.reasoning_content;
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  return text;
}

/** 消息时钟：只作为 hover 工具栏的元信息（`<time dateTime>` 语义保留）。 */

/**
 * 该助手消息之前最近的一条真实用户输入（重试要用它的绝对下标）。
 *
 *  运行时上下文不算用户输入；找不到就返回 undefined（不给重试）。
 */
function previousUserMessage(
  message: Message,
  allMessages: readonly Message[] | undefined,
  indexOffset: number,
  indexOf: ReadonlyMap<Message, number>,
): { text: string; index: number } | undefined {
  if (message.role !== 'assistant' || !allMessages) return undefined;
  const currentIndex = indexOf.get(message) ?? -1;
  if (currentIndex < 0) return undefined;
  for (let cursor = currentIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = allMessages[cursor];
    if (candidate?.role !== 'user') continue;
    if (runtimeMessageKind(candidate) !== undefined) continue;
    return { text: candidate.content, index: cursor + indexOffset };
  }
  return undefined;
}

/**
 * 历史消息渲染（item 流里的  一类）。
 *
 * 工具消息不再走这里：它们在建 item 时就被  配对成  item，
 * 与运行态共用同一张卡（见 transcript-items.ts）。
 */
function TranscriptMessage({
  message,
  messageIndex,
  previousUser,
  source,
  cardsDefaultOpen,
  groupStart,
  onCopy,
  onEdit,
  onRetry,
}: {
  message: Message;
  /** 该消息在  的  里的绝对下标；缺失时不提供撤回。 */
  messageIndex: number | undefined;
  /** 该助手消息前一条真实用户输入及其下标。 */
  previousUser?: { text: string; index: number };
  /** A2A 消息的回信地址（由被吸收的 vessel:source 行提供）。 */
  source?: string;
  cardsDefaultOpen: boolean;
  /** 连续同发言人的后续条目不再重复发言人头。 */
  groupStart: boolean;
  onCopy: (text: string) => void;
  onEdit: (keepMessages: number, text: string) => void;
  onRetry: (keepMessages: number, text: string) => void;
}) {
  if (message.role === 'system') return null;
  if (message.role === 'tool') return null;

  // 时间只出现在 hover 工具栏里（与 live 一致）：气泡内与发言人头都不放。
  const clock = formatClock(message.timestamp);
  const meta = clock !== '' ? clock : undefined;
  const hasMeta = meta !== undefined;

  if (message.role === 'user') {
    // A2A 投递：runtime 给这条输入写了 ，渲染成 agent 卡而不是用户气泡。
    const agentSender = agentMessageSender(message);
    if (agentSender !== undefined) {
      return (
        <AgentMessageCard
          sender={agentSender}
          content={message.content}
          ts={message.timestamp}
          {...(source !== undefined ? { source } : {})}
          defaultOpen={cardsDefaultOpen}
        />
      );
    }
    const actions: MessageAction[] = [];
    if (message.content.trim().length > 0) {
      actions.push({
        id: 'copy',
        label: t('chat.message.copy'),
        onSelect: () => onCopy(message.content),
      });
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
          <MessageFold>{message.content}</MessageFold>
        </div>
        {hasMeta || actions.length > 0 ? (
          <MessageActions className="justify-end" actions={actions} meta={meta} />
        ) : null}
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  // 思考块就在这个 item 里渲：被 live 认领的消息走不到这里（见 historyReasoning）。
  const reasoning = historyReasoning(message);
  const actions: MessageAction[] = [];
  if (message.content.trim().length > 0) {
    actions.push({
      id: 'copy',
      label: t('chat.message.copy'),
      onSelect: () => onCopy(message.content),
    });
  }
  if (calls.length === 0 && previousUser !== undefined && previousUser.text.trim().length > 0) {
    actions.push({
      id: 'retry',
      label: t('chat.message.retry'),
      onSelect: () => onRetry(previousUser.index, previousUser.text),
    });
  }
  return (
    <div className="msg-assistant group max-w-full">
      {groupStart && (
        <div className="mb-1.5 block font-mono text-2xs tracking-widest uppercase text-faint">
          {t('chat.role.assistant')}
        </div>
      )}
      {/* 思考在正文之前：与 live 一致（run 里 reasoning item 先于 text item）。 */}
      {reasoning !== undefined && <ReasoningBlock text={reasoning} streaming={false} />}
      {message.content && (
        <MessageFold>
          <Markdown className="msg-text" text={message.content} />
        </MessageFold>
      )}
      {hasMeta || actions.length > 0 ? (
        <MessageActions className="mt-1" actions={actions} meta={meta} />
      ) : null}
    </div>
  );
}

/** 一条 item → 渲染节点。非消息类由调用方给（复用各自的组件）。 */
export type TranscriptItemRenderer = (item: TranscriptItem) => ReactNode;

/**
 * item 流 → 消息区。
 *
 * 入场动画的边界（见 `components/ui/useEnteringItemKeys.ts` 的说明）：
 * - **live item 播**：`renderItem` 渲染的都是事件流追加进来的项（用户气泡 / agent 卡 /
 *   正文），挂载即播一次；
 * - **历史消息不播**：历史加载是「回填 / 换页」不是「追加」，而且 live 落盘后会把位置
 *   让给历史消息（`run:<runId>:input` 由 `msg:<absIndex>` 接管，key 不同 = DOM 节点
 *   重建），两边都播就是同一段正文淡入两次。
 */
export function Transcript({
  items,
  allMessages,
  messageIndexOffset = 0,
  cardsDefaultOpen = false,
  renderItem,
  onEditMessage,
  onRetryMessage,
}: {
  items: readonly TranscriptItem[];
  /** 已加载的完整消息窗口（未做可见性过滤），用于回溯窗口外的前一条用户输入。 */
  allMessages?: readonly Message[];
  /**  在完整  里的绝对下标。 */
  messageIndexOffset?: number;
  cardsDefaultOpen?: boolean;
  /** 非消息类 item（正文 / 思考 / 工具 / notice / 排队）的渲染器。 */
  renderItem: TranscriptItemRenderer;
  onEditMessage: (keepMessages: number, text: string) => void;
  onRetryMessage: (keepMessages: number, text: string) => void;
}) {
  const copy = useMessageCopy();
  // 每条消息都要知道自己在完整窗口里的绝对下标；一次建表，避免每渲染 O(n) 查找
  // （2000 条实测 2.83ms/渲染，流式 20Hz 就是 56ms/s）。
  const indexOf = useMemo(() => {
    const map = new Map<Message, number>();
    const list = allMessages ?? [];
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index];
      if (message !== undefined) map.set(message, index);
    }
    return map;
  }, [allMessages]);
  if (items.length === 0) return null;

  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const item of items) {
    const day = item.ts !== undefined ? localDayKey(item.ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="mt-3.5 mb-2.5 flex items-center justify-center gap-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-faint"
          key={`day-${day}`}
        >
          <span>{localDayLabel(item.ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (item.kind === 'message') {
      const message = item.message;
      const sourceIndex = indexOf.get(message);
      const messageIndex =
        sourceIndex !== undefined && sourceIndex >= 0
          ? sourceIndex + messageIndexOffset
          : undefined;
      nodes.push(
        <TranscriptMessage
          key={item.key}
          message={message}
          messageIndex={messageIndex}
          previousUser={previousUserMessage(message, allMessages, messageIndexOffset, indexOf)}
          {...(item.sourceText !== undefined ? { source: item.sourceText } : {})}
          cardsDefaultOpen={cardsDefaultOpen}
          groupStart={item.groupStart !== false}
          onCopy={copy}
          onEdit={onEditMessage}
          onRetry={onRetryMessage}
        />,
      );
      continue;
    }
    nodes.push(<Fragment key={item.key}>{renderItem(item)}</Fragment>);
  }
  return <div className="flex flex-col gap-4 py-1.5 pb-2.5">{nodes}</div>;
}
