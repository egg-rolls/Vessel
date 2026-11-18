import type { MessageBarItem } from '../components/MessageBar';
import type { ConnectionState } from '../gateway/client';
import type { GatewayRpcBlock } from '../gateway/session-invalid';
import { t } from '../i18n';

export interface ShellNoticeInput {
  lastError: string | null;
  tokenError: string | null;
  stale: boolean;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  /**
   * 最近一次 RPC 被拒（401 / Origin 白名单）；null = 当前没有。
   *
   * 0.59：这一条排在最前面。它的可怕之处不是「出错了」，而是**界面毫无表示** ——
   * 浏览器在 `127.0.0.1:8644` 时 `POST /v1/rpc` 全 401，于是 rotate 的权限卡永远拿不到、
   * 点不了，用户只能按停止。所以只要它成立，就先把它说出来。
   */
  sessionInvalid?: GatewayRpcBlock | null;
  onRelogin: () => void;
  onDismissError: () => void;
  onRetry: () => void;
  onOpenConnection: () => void;
}

/**
 * 外壳级持久提示（0.37，原顶部提示条）：被拒 / 错误 / 鉴权 / 断线。
 *
 * 只生成 `MessageBarItem`，不关心渲染位置；由 `AppShell` 与 pending、构建过期、
 * toast 一起交给 AppBar 中心的 `MessageBar`。
 */
export function shellNoticeItems(input: ShellNoticeInput): MessageBarItem[] {
  const items: MessageBarItem[] = [];

  const blocked = input.sessionInvalid ?? null;
  if (blocked !== null) {
    items.push(
      blocked.kind === 'session'
        ? {
            id: 'shell-rpc-session',
            tone: 'error',
            text: t('gateway.rpc.sessionInvalid'),
            hint: t('gateway.rpc.sessionInvalidHint'),
            // 重新登录走既有的 notifyAuthRequired 通道（AuthProvider 已经在听）。
            actions: [{ label: t('gateway.rpc.relogin'), onClick: input.onRelogin }],
          }
        : {
            id: 'shell-rpc-origin',
            tone: 'error',
            text: t('gateway.rpc.originBlocked', { detail: blocked.message }),
            hint: t('gateway.rpc.originBlockedHint'),
            // Origin 被拒不是会话问题：给连接设置（那里有地址/白名单的诊断）。
            actions: [{ label: t('app.openConnection'), onClick: input.onOpenConnection }],
          },
    );
  }

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
