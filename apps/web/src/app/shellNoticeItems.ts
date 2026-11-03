import type { MessageBarItem } from '../components/MessageBar';
import type { ConnectionState } from '../gateway/client';
import { t } from '../i18n';

export interface ShellNoticeInput {
  lastError: string | null;
  tokenError: string | null;
  stale: boolean;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  onDismissError: () => void;
  onRetry: () => void;
  onOpenConnection: () => void;
}

/**
 * 外壳级持久提示（0.37，原顶部提示条）：错误 / 鉴权 / 断线。
 *
 * 只生成 `MessageBarItem`，不关心渲染位置；由 `AppShell` 与 pending、构建过期、
 * toast 一起交给 AppBar 中心的 `MessageBar`。
 */
export function shellNoticeItems(input: ShellNoticeInput): MessageBarItem[] {
  const items: MessageBarItem[] = [];

  if (input.lastError) {
    items.push({
      id: 'shell-error',
      tone: 'error',
      text: input.lastError,
      onDismiss: input.onDismissError,
    });
  }

  if (input.tokenError) {
    items.push({
      id: 'shell-token-error',
      tone: 'error',
      text: input.tokenError,
      actions: [{ label: t('app.openConnection'), onClick: input.onOpenConnection }],
    });
  }

  if (input.stale) {
    items.push({
      id: 'shell-stale',
      tone: 'warn',
      text:
        input.connectionState === 'reconnecting'
          ? t('app.reconnecting', { count: Math.max(1, input.reconnectAttempt) })
          : t('app.stale'),
      actions: [
        { label: t('app.retryNow'), onClick: input.onRetry },
        { label: t('app.connectionSettings'), onClick: input.onOpenConnection },
      ],
    });
  }

  return items;
}
