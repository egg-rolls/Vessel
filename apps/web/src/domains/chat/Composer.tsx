import { useEffect, useRef } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { AutoGrowTextarea, Button } from '../../components/ui';
import { t } from '../../i18n';
import { ChatDock } from './ChatDock';

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
  onStop,
  stopping = false,
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
  /** 当前会话有 running run 时的停止入口（0.18，替代 run 卡片上的取消按钮）。 */
  onStop?: () => void;
  stopping?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const wasSubmittingRef = useRef(submitting);
  const compositionEndRef = useRef(0);
  const canSend = hasToken && connected && !disabled && !submitting && value.trim().length > 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  // 发送结束后把焦点还给输入框；用户已把焦点移走时不抢。
  useEffect(() => {
    if (wasSubmittingRef.current && !submitting && mountedRef.current) {
      const active = document.activeElement;
      const focusLeftInput =
        active === document.body ||
        (active instanceof Element && active.closest('.composer-row') !== null);
      if (focusLeftInput && hasToken && connected && !disabled) inputRef.current?.focus();
    }
    wasSubmittingRef.current = submitting;
  }, [submitting, hasToken, connected, disabled]);

  const placeholder = !hasToken
    ? '请先在设置 → 连接中配置 gateway token'
    : !connected
      ? '连接断开，重连后可继续发送'
      : '输入 prompt';

  return (
    <ChatDock>
      <div className="composer">
        <div className="composer-meta">
          <Tooltip label={targetLabel}>
            <span className="composer-target">{targetLabel}</span>
          </Tooltip>
          <span className="composer-meta-right">
            {onStop && (
              <button
                type="button"
                className="link-btn composer-stop"
                onClick={onStop}
                disabled={stopping}
              >
                {stopping ? t('chat.run.stopping') : t('chat.run.stop')}
              </button>
            )}
            <span className="composer-hint dim">Enter 发送 · Shift+Enter 换行</span>
          </span>
        </div>
        <div className="composer-row">
          <AutoGrowTextarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onCompositionEnd={() => {
              compositionEndRef.current = Date.now();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                // Safari 在 compositionend 后可能再补一个 Enter：时间窗内只阻止默认行为。
                if (Date.now() - compositionEndRef.current < 50) return;
                if (canSend) onSubmit();
              }
            }}
            placeholder={placeholder}
            disabled={!hasToken || !connected || submitting || disabled}
            spellCheck={false}
            aria-label={t('chat.composer.input')}
            enterKeyHint="send"
          />
          {!hasToken || !connected ? (
            <Button variant="primary" onClick={onOpenConnection}>
              配置连接
            </Button>
          ) : (
            <Button variant="primary" onClick={onSubmit} disabled={!canSend}>
              {submitting ? '发送中' : '发送'}
            </Button>
          )}
        </div>
      </div>
    </ChatDock>
  );
}
