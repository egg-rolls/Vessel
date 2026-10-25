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
    ? t('chat.composer.placeholderNoToken')
    : !connected
      ? t('chat.composer.placeholderDisconnected')
      : t('chat.composer.placeholder');

  return (
    <ChatDock>
      <div className="w-full max-w-[var(--dock-width)] mx-auto px-3.5 pt-2.25 pb-3 rounded-lg bg-raised shadow-elev-2 focus-within:shadow-[var(--elev-2),var(--focus-ring)]">
        <div className="flex items-center justify-between gap-3 mb-1.5 text-xs text-faint">
          <Tooltip label={targetLabel}>
            <span className="composer-target">{targetLabel}</span>
          </Tooltip>
          <span className="flex-none flex items-center gap-2.5">
            {onStop && (
              <Button
                type="button"
                variant="link"
                className="text-danger hover:text-danger disabled:opacity-60"
                onClick={onStop}
                disabled={stopping}
              >
                {stopping ? t('chat.run.stopping') : t('chat.run.stop')}
              </Button>
            )}
            <span className="flex-none font-mono text-xs text-muted">
              {t('chat.composer.hint')}
            </span>
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
              {t('common.configureConnection')}
            </Button>
          ) : (
            <Button variant="primary" onClick={onSubmit} disabled={!canSend}>
              {submitting ? t('chat.composer.sending') : t('chat.composer.send')}
            </Button>
          )}
        </div>
      </div>
    </ChatDock>
  );
}
