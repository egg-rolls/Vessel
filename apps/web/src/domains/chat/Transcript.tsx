import type { Message } from '../../gateway/types';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function TranscriptMessage({ message }: { message: Message }) {
  if (message.role === 'system') return null;

  if (message.role === 'tool') {
    const label = message.name || message.tool_call_id || 'tool';
    return (
      <div className="msg msg-tool">
        <span className="msg-role mono">{label}</span>
        <pre className="msg-tool-result">{message.content}</pre>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">{message.content}</div>
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  return (
    <div className="msg msg-assistant">
      <div className="msg-role">助手</div>
      {message.content && <div className="msg-text">{message.content}</div>}
      {calls.map((call) => (
        <div className="msg-toolcall" key={call.id}>
          <span className="mono">{call.function.name}</span>
          <span className="dim">{truncate(call.function.arguments || '', 120)}</span>
        </div>
      ))}
    </div>
  );
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
      {messages.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 窗口切片用完整列表下标做稳定 key
        <TranscriptMessage key={`${startIndex + index}`} message={message} />
      ))}
    </div>
  );
}
