import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';

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

function TranscriptMessage({ message }: { message: Message }) {
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
    return (
      <div className="msg-user flex max-w-full justify-end">
        <div className="msg-bubble">
          {message.content}
          <MessageTime message={message} block />
        </div>
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  return (
    <div className="msg-assistant max-w-full">
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
    </div>
  );
}

/** 按消息时间做本地日分组；没有 timestamp 的消息不显示分组头（降级）。 */
function withDayGroups(messages: Message[], startIndex: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  messages.forEach((message, index) => {
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
      // biome-ignore lint/suspicious/noArrayIndexKey: 窗口切片用完整列表下标做稳定 key
      <TranscriptMessage key={`${startIndex + index}`} message={message} />,
    );
  });
  return nodes;
}

export function Transcript({
  messages,
  startIndex,
  hiddenCount,
  onLoadEarlier,
  children,
}: {
  messages: Message[];
  /** 窗口在完整可见消息里的起始下标，用于稳定 key。 */
  startIndex: number;
  hiddenCount: number;
  onLoadEarlier: () => void;
  /** 实时 run 的展开项与排队 notice：与历史消息共享同一列表与间距。 */
  children?: ReactNode;
}) {
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
      {withDayGroups(messages, startIndex)}
      {children}
    </div>
  );
}
