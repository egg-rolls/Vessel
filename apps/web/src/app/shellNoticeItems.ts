import type { ConnectionState } from '../gateway/client';
import type { GatewayRpcBlock } from '../gateway/session-invalid';
import { t } from '../i18n';

/**
 * 提示项的结构类型 —— 与 `components/MessageBar` 的 `MessageBarItem` **逐字段一致**。
 *
 * 为什么不去 import 那个类型：`app/` 层这个纯函数要能被 `src/*.test.ts` 直接单测，
 * 而根 tsconfig 没有 DOM lib、也不解析 `@vessel-agent/plugin-ui`，一旦 import 组件文件，
 * 它的类型会把 `MessageBar.tsx` / `ui/Button.tsx` 一起拖进根 typecheck 并报错。
 * 一致性由 `AppShell` 那处赋值（`items` 传给 `MessageBar`）在编译期兜住：字段对不上就红。
 */
export interface ShellNoticeAction {
  label: string;
  onClick: () => void;
}

export interface ShellNoticeItem {
  id: string;
  tone: 'neutral' | 'info' | 'success' | 'warn' | 'error';
  text: string;
  hint?: string;
  actions?: readonly ShellNoticeAction[];
  onDismiss?: () => void;
}

export interface ShellNoticeInput {
  lastError: string | null;
  tokenError: string | null;
  stale: boolean;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  /**
   * 最近一次 RPC 被拒（401 / Origin 白名单 / 一次都没连通过）；null = 当前没有。
   *
   * 0.59：这一条排在最前面。它的可怕之处不是「出错了」，而是**界面毫无表示** ——
   * 浏览器在 `127.0.0.1:8644` 时 `POST /v1/rpc` 全 401，于是 rotate 的权限卡永远拿不到、
   * 点不了，用户只能按停止。所以只要它成立，就先把它说出来。
   */
  sessionInvalid?: GatewayRpcBlock | null;
  /**
   * 「重新登录」这颗按钮在当前部署里有没有目标（0.59）。
   *
   * `authEnabled === false`（没配登录）/ `/auth/status` 打不通时，重新登录**不会**回登录页，
   * 点了等于什么都没发生 —— 那种情况下按钮要降级成「打开连接设置」，而不是留一颗假按钮。
   */
  canRelogin?: boolean;
  onRelogin: () => void;
  onDismissError: () => void;
  onRetry: () => void;
  onOpenConnection: () => void;
}

/**
 * 外壳级持久提示（0.37，原顶部提示条）：被拒 / 错误 / 鉴权 / 断线。
 *
 * 只生成 `ShellNoticeItem`，不关心渲染位置；由 `AppShell` 与 pending、构建过期、
 * toast 一起交给 AppBar 中心的 `MessageBar`。
 */
export function shellNoticeItems(input: ShellNoticeInput): ShellNoticeItem[] {
  const items: ShellNoticeItem[] = [];

  const blocked = input.sessionInvalid ?? null;
  /**
   * connection 档（一次都没连通过）存在时，压掉既有的网络类提示：
   * `lastError`（probe 的 unreachable / originRejected）与 `stale`（重连中 / 已过期）。
   * 否则同一个「连不上」会在同一条提示带上出现两次。
   *
   * **token / 协议错误不在此列**：它们是鉴权类结论，永远不能被去重吞掉。
   */
  const connectionBlocked = blocked?.kind === 'connection';

  // 鉴权类永远第一（可行动性最高，也永不被去重）。
  if (input.tokenError) {
    items.push({
      id: 'shell-token-error',
      tone: 'error',
      text: input.tokenError,
      actions: [{ label: t('app.openConnection'), onClick: input.onOpenConnection }],
    });
  }

  if (blocked?.kind === 'session') {
    items.push({
      id: 'shell-rpc-session',
      tone: 'error',
      text: t('gateway.rpc.sessionInvalid'),
      hint: t('gateway.rpc.sessionInvalidHint'),
      // 重新登录走既有的 notifyAuthRequired 通道（AuthProvider 已经在听）；
      // auth 没启用时这颗按钮没有目标，降级成连接设置（见 canRelogin）。
      actions: [
        input.canRelogin === false
          ? { label: t('gateway.rpc.connectInstead'), onClick: input.onOpenConnection }
          : { label: t('gateway.rpc.relogin'), onClick: input.onRelogin },
      ],
    });
  } else if (blocked?.kind === 'origin') {
    items.push({
      id: 'shell-rpc-origin',
      tone: 'error',
      text: t('gateway.rpc.originBlocked'),
      hint: t('gateway.rpc.originBlockedHint', { detail: blocked.message }),
      // Origin 被拒不是会话问题：给连接设置（那里有地址/白名单的诊断）。
      actions: [{ label: t('app.openConnection'), onClick: input.onOpenConnection }],
    });
  } else if (blocked?.kind === 'connection' && !input.tokenError) {
    // token 错误存在时让位（鉴权结论更高，且它已经把「连不上」的原因说清了）。
    items.push({
      id: 'shell-rpc-unreachable',
      tone: 'error',
      // 文案只说人话，不给任何命令行操作（宪法十四条）。
      text: t('gateway.rpc.unreachable'),
      hint: t('gateway.rpc.unreachableHint', {
        count: blocked.attempts ?? 0,
        detail: blocked.message,
      }),
      actions: [{ label: t('app.openConnection'), onClick: input.onOpenConnection }],
    });
  }

  if (input.lastError && !connectionBlocked) {
    items.push({
      id: 'shell-error',
      tone: 'error',
      text: input.lastError,
      onDismiss: input.onDismissError,
    });
  }

  if (input.stale && !connectionBlocked) {
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
