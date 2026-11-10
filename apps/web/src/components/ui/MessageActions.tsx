import { type ReactNode, useCallback } from 'react';
import { t } from '../../i18n';
import { useOptionalToast } from '../ToastProvider';
import { IconButton } from '../Tooltip';
import { copyText } from './clipboard';
import { cn } from './cn';
import { Icon } from './Icon';

export interface MessageAction {
  id: 'copy' | 'edit' | 'retry' | 'resend' | 'transcript' | 'reply' | 'retract';
  /** 已 i18n，直接进 Tooltip / aria-label。 */
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MessageActionsProps {
  actions: readonly MessageAction[];
  /**
   * 图标左侧的元信息槽（消息时间等）。与图标同一排、同一 hover 显隐容器：
   * 时间从气泡/卡片头搬到这里，默认隐藏，hover / focus 时一起显现；
   * `pointer-coarse`（触屏）下整组常显，时间才不至于是“看不见的信息”。
   */
  meta?: ReactNode;
  /** 布局覆盖。 */
  className?: string;
}

/**
 * 复制文本并以 toast 反馈；没有 ToastProvider 时只复制、不提示。
 * `successLabel` 默认是聊天操作组文案；团队消息传 `common.copied`。
 */
export function useMessageCopy(
  successLabel: string = t('chat.message.copied'),
): (text: string) => void {
  const toast = useOptionalToast();
  return useCallback(
    (text: string) => {
      void copyText(text)
        .then(() => toast?.success(successLabel))
        .catch((error: unknown) => {
          toast?.error(error instanceof Error ? error.message : String(error));
        });
    },
    [toast, successLabel],
  );
}

/**
 * 消息气泡下方的操作组：默认 hover / focus-within 显示，触屏常显。
 * 只负责布局与可访问性；具体动作由调用方提供。
 *
 * 「只有时间、没有动作」的消息也要能显示时间，所以早退条件是「两者都空」而不是
 * `actions.length === 0`。
 */
export function MessageActions({ actions, meta, className }: MessageActionsProps) {
  const hasMeta = meta !== undefined && meta !== null && meta !== false;
  const hasActions = actions.length > 0;
  if (!hasActions && !hasMeta) return null;
  return (
    <div
      // 只有时间、没有动作时不冒充「消息操作」组：读屏不该听到一个空的 action group。
      {...(hasActions ? { role: 'group' as const, 'aria-label': t('chat.message.actions') } : {})}
      className={cn(
        'flex w-fit flex-row flex-nowrap items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        className,
      )}
    >
      {hasMeta && (
        // 时间不抢焦点、不进 tab 序列：`<time>` 本身不可聚焦，读屏随正文一起读到。
        <span className="mr-0.5 shrink-0 font-mono text-2xs tabular-nums text-faint">{meta}</span>
      )}
      {actions.map((action) => (
        <IconButton
          key={action.id}
          label={action.label}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          <Icon name={action.id} />
        </IconButton>
      ))}
    </div>
  );
}
