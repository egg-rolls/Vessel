import { useCallback } from 'react';
import { t } from '../../i18n';
import { useOptionalToast } from '../ToastProvider';
import { IconButton } from '../Tooltip';
import { copyText } from './clipboard';
import { cn } from './cn';
import { Icon } from './Icon';

export interface MessageAction {
  id: 'copy' | 'edit' | 'retry';
  /** 已 i18n，直接进 Tooltip / aria-label。 */
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MessageActionsProps {
  actions: readonly MessageAction[];
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
 */
export function MessageActions({ actions, className }: MessageActionsProps) {
  if (actions.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 契约冻结 role=group，容器不是表单
    <div
      role="group"
      aria-label={t('chat.message.actions')}
      className={cn(
        'flex flex-wrap items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        className,
      )}
    >
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
