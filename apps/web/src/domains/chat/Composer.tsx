import { useEffect, useRef } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { AutoGrowTextarea, Button } from '../../components/ui';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { ChatDock } from './ChatDock';
import {
  type ComposerContextUsage,
  ComposerField,
  ComposerRefsArea,
  ComposerSendButton,
  refIndexForId,
  refsToAttachments,
} from './ComposerChrome';

/**
 * 会话输入框卡片：卡片 > 引用区 > 字段容器 > (textarea + 工具栏)。
 *
 * - 上：引用区（附件 / 文档 / 引用项，受控 `refs` + `onRemoveRef`；空则不占高）；
 * - 下：{@link ComposerField} 把 textarea 与横向工具栏包成一块凹槽 —— 底色、圆角、
 *   内衬、焦点环都由容器承担，两者背景透明；
 * - textarea 行为不变：Enter 发送 / Shift+Enter 换行 / IME 保护。
 */
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
  refs,
  onRemoveRef,
  contextUsage,
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
  /**
   * 待发送的附件引用（只有路径，没有正文）。缺省 / 空数组时不渲染 chip 行。
   * 状态由调用方持有：文件选择对话框与工具栏按钮由 composer-bar 那单接上。
   */
  refs?: readonly MessageRef[];
  /** 删除一条引用（下标即 refs 里的位置）。 */
  onRemoveRef?: (index: number) => void;
  /** 发送键左侧的上下文用量；缺省（未知）时不渲染。 */
  contextUsage?: ComposerContextUsage;
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
        (active instanceof Element && active.closest('.composer-field') !== null);
      if (focusLeftInput && hasToken && connected && !disabled) inputRef.current?.focus();
    }
    wasSubmittingRef.current = submitting;
  }, [submitting, hasToken, connected, disabled]);

  const placeholder = !hasToken
    ? t('chat.composer.placeholderNoToken')
    : !connected
      ? t('chat.composer.placeholderDisconnected')
      : t('chat.composer.placeholder');

  // 引用区唯一实现：MessageRef[] → 通用 chip 行（id 用 path），删除按 path 回写下标。
  const refItems = refsToAttachments(refs ?? []);
  const removeRef = (id: string) => {
    const index = refIndexForId(refs ?? [], id);
    if (index >= 0) onRemoveRef?.(index);
  };

  return (
    <ChatDock>
      {/* 焦点环由 `.composer-field` 的 `:focus-within` 出（一层，标出「输入 + 工具栏」），
          卡片自己不再叠加第二层环。 */}
      <div className="w-full max-w-[var(--dock-width)] mx-auto px-3.5 pt-2.25 pb-3 rounded-lg bg-raised shadow-elev-2">
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
        <ComposerRefsArea
          className="composer-refs-row"
          items={refItems}
          onRemove={onRemoveRef === undefined ? undefined : removeRef}
        />
        <ComposerField
          contextUsage={contextUsage}
          primary={
            !hasToken || !connected ? (
              <Button variant="primary" onClick={onOpenConnection}>
                {t('common.configureConnection')}
              </Button>
            ) : (
              <ComposerSendButton
                label={submitting ? t('chat.composer.sending') : t('chat.composer.send')}
                disabled={!canSend}
                onClick={onSubmit}
              />
            )
          }
        >
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
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              // Ctrl / Cmd + Enter 是显式发送和弦；裸 Enter 保持既有发送行为，
              // Shift+Enter 仍换行。三条路径共用同一个 canSend 判定。
              const chord = event.ctrlKey || event.metaKey;
              if (!chord && event.shiftKey) return;
              event.preventDefault();
              // Safari 在 compositionend 后可能再补一个 Enter：时间窗内只阻止默认行为。
              if (Date.now() - compositionEndRef.current < 50) return;
              if (canSend) onSubmit();
            }}
            placeholder={placeholder}
            disabled={!hasToken || !connected || submitting || disabled}
            spellCheck={false}
            aria-label={t('chat.composer.input')}
            enterKeyHint="send"
          />
        </ComposerField>
      </div>
    </ChatDock>
  );
}
