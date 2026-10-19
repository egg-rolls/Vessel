import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function MessageTime({ message }: { message: Message }) {
  const clock = formatClock(message.timestamp);
  if (!clock) return null;
  return (
    <time className="msg-time" dateTime={new Date(message.timestamp ?? 0).toISOString()}>
      {clock}
    </time>
  );
}

function TranscriptMessage({ message }: { message: Message }) {
  if (message.role === 'system') return null;

  if (message.role === 'tool') {
    const label = message.name || message.tool_call_id || 'tool';
    return (
      <div className="msg msg-tool">
        <div className="msg-meta">
          <span className="msg-role mono">{label}</span>
          <MessageTime message={message} />
        </div>
        <pre className="msg-tool-result">{message.content}</pre>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">
          {message.content}
          <MessageTime message={message} />
        </div>
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  return (
    <div className="msg msg-assistant">
      <div className="msg-meta">
        <div className="msg-role">助手</div>
        <MessageTime message={message} />
      </div>
      {message.content && <Markdown className="msg-text" text={message.content} />}
      {calls.map((call) => (
        <div className="msg-toolcall" key={call.id}>
          <span className="mono">{call.function.name}</span>
          <span className="dim">{truncate(call.function.arguments || '', 120)}</span>
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
        <div className="day-divider" key={`day-${day}`}>
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
}: {
  messages: Message[];
  /** 窗口在完整可见消息里的起始下标，用于稳定 key。 */
  startIndex: number;
  hiddenCount: number;
  onLoadEarlier: () => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="transcript">
      {hiddenCount > 0 && (
        <button type="button" className="load-earlier" onClick={onLoadEarlier}>
          加载更早（还有 {hiddenCount} 条）
        </button>
      )}
      {withDayGroups(messages, startIndex)}
    </div>
  );
}
