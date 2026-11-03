import type { ReactNode } from 'react';
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
 * 找该助手消息前一条真实用户输入及其下标。`allMessages` 是 `sessions.get` 的完整
 * 消息序列（跨窗口回溯），返回的下标直接作为 `keep_messages`；runtime 上下文消息
 * （`vessel:*`）不是用户输入，跳过。
 */
function previousUserMessage(
  message: Message,
  allMessages: readonly Message[] | undefined,
): { text: string; index: number } | undefined {
  if (message.role !== 'assistant' || !allMessages) return undefined;
  const currentIndex = allMessages.indexOf(message);
  if (currentIndex < 0) return undefined;
  for (let cursor = currentIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = allMessages[cursor];
    if (candidate?.role !== 'user') continue;
    if (runtimeMessageKind(candidate) !== undefined) continue;
    return { text: candidate.content, index: cursor };
  }
  return undefined;
}

/** 按消息时间做本地日分组；没有 timestamp 的消息不显示分组头（降级）。 */
function withDayGroups(
  messages: Message[],
  startIndex: number,
  allMessages: readonly Message[] | undefined,
  onCopy: (text: string) => void,
  onEdit: (keepMessages: number, text: string) => void,
  onRetry: (keepMessages: number, text: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  messages.forEach((message, index) => {
    // 撤回下标只认 `sessions.get` 的完整消息序列；对象不在其中时不提供撤回。
    const sourceIndex = allMessages?.indexOf(message);
    const messageIndex = sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex : undefined;
    const day = message.timestamp !== undefined ? localDayKey(message.timestamp) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="mt-3.5 mb-2.5 flex items-center justify-center gap-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-faint"
          key={`day-${day}`}
        >
          <span>{localDayLabel(message.timestamp ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    nodes.push(
      <TranscriptMessage
        // biome-ignore lint/suspicious/noArrayIndexKey: 窗口切片用完整列表下标做稳定 key
        key={`${startIndex + index}`}
        message={message}
        messageIndex={messageIndex}
        previousUser={previousUserMessage(message, allMessages)}
        onCopy={onCopy}
        onEdit={onEdit}
        onRetry={onRetry}
      />,
    );
  });
  return nodes;
}

export function Transcript({
  messages,
  allMessages,
  startIndex,
  hiddenCount,
  onLoadEarlier,
  onEditMessage,
  onRetryMessage,
  children,
}: {
  messages: Message[];
  /** 完整可见消息序列，用于回溯窗口外的前一条用户输入。 */
  allMessages?: readonly Message[];
  /** 窗口在完整可见消息里的起始下标，用于稳定 key。 */
  startIndex: number;
  hiddenCount: number;
  onLoadEarlier: () => void;
  /** 编辑 = 确认后删除该消息及其后历史，并把原文写回 Composer。 */
  onEditMessage: (keepMessages: number, text: string) => void;
  /** 重试 = 确认后删除该回复及其后历史，并重新发送前一条用户内容。 */
  onRetryMessage: (keepMessages: number, text: string) => void;
  /** 实时 run 的展开项与排队 notice：与历史消息共享同一列表与间距。 */
  children?: ReactNode;
}) {
  const copy = useMessageCopy();
  if (messages.length === 0 && !children) return null;
  return (
    <div className="flex flex-col gap-4 py-1.5 pb-2.5">
      {hiddenCount > 0 && (
        <button
          type="button"
          className="self-start rounded-full bg-sunken px-3 py-1.5 text-sm text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
          onClick={onLoadEarlier}
        >
          {t('chat.loadEarlier', { count: hiddenCount })}
        </button>
      )}
      {withDayGroups(messages, startIndex, allMessages, copy, onEditMessage, onRetryMessage)}
      {children}
    </div>
  );
}
