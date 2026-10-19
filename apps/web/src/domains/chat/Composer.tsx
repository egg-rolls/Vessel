import { useEffect, useRef } from 'react';

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  submitting,
  targetLabel,
  hasToken,
  connected,
  onOpenConnection,
  focusSignal = 0,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitting: boolean;
  targetLabel: string;
  hasToken: boolean;
  connected: boolean;
  onOpenConnection: () => void;
  /** 值变化时把焦点移入输入框（新建会话草稿）。 */
  focusSignal?: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = hasToken && connected && !disabled && !submitting && value.trim().length > 0;

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  // 输入框随内容增高（最多 160px / 34dvh）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 输入变化时重算高度
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  const placeholder = !hasToken
    ? '请先在设置 → 连接中配置 gateway token'
    : !connected
      ? '连接断开，重连后可继续发送'
      : '输入 prompt';

  return (
    <footer className="composer-area">
      <div className="composer">
        <div className="composer-meta">
          <span className="composer-target" title={targetLabel}>
            {targetLabel}
          </span>
          <span className="composer-hint dim">Enter 发送 · Shift+Enter 换行</span>
        </div>
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) onSubmit();
              }
            }}
            placeholder={placeholder}
            disabled={!hasToken || !connected || submitting || disabled}
            spellCheck={false}
          />
          {!hasToken || !connected ? (
            <button type="button" className="btn btn-primary" onClick={onOpenConnection}>
              配置连接
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={!canSend}
            >
              {submitting ? '发送中' : '发送'}
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
