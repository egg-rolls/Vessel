import { useConnection } from '../gateway/ConnectionProvider';
import { routeBreadcrumb } from './nav';
import type { Route } from './router';

function connectionLabel(state: string): string {
  switch (state) {
    case 'open':
      return 'online';
    case 'connecting':
      return '连接中…';
    case 'reconnecting':
      return '重连中…';
    case 'closed':
      return '已断开';
    case 'error':
      return '连接失败';
    default:
      return '未连接';
  }
}

export function AppBar({
  route,
  onOpenPalette,
  onToggleSessions,
  sessionsOpen = false,
  navigate,
}: {
  route: Route;
  onOpenPalette: () => void;
  onToggleSessions?: () => void;
  sessionsOpen?: boolean;
  navigate: (route: Route) => void;
}) {
  const { connectionState, tenantId, hasToken } = useConnection();
  const connLabel = hasToken ? connectionLabel(connectionState) : '未连接';

  return (
    <header className="appbar">
      {onToggleSessions && (
        <button
          id="sessions-toggle"
          type="button"
          className="appbar-icon"
          aria-label="打开会话列表"
          aria-expanded={sessionsOpen}
          aria-controls="chat-sessions"
          onClick={onToggleSessions}
        >
          <span aria-hidden="true">☰</span>
        </button>
      )}
      <span className="brand">Vessel</span>
      <span className="appbar-path" aria-live="polite">
        {routeBreadcrumb(route)}
      </span>

      <div className="appbar-spacer" />

      <button
        type="button"
        className="palette-trigger"
        onClick={onOpenPalette}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <span className="palette-trigger-icon" aria-hidden="true">
          ⌕
        </span>
        <span className="palette-trigger-text">搜索或输入命令</span>
        <kbd className="kbd">⌘K</kbd>
      </button>

      <button
        type="button"
        className={`conn conn-${hasToken ? connectionState : 'idle'}`}
        onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
        title="gateway 连接状态；点击打开连接设置"
      >
        <span className="conn-dot" aria-hidden="true" />
        <span>{connLabel}</span>
      </button>

      <button
        type="button"
        className="tenant-chip"
        onClick={() => navigate({ domain: 'settings', tab: 'tenants' })}
        title="当前连接租户；点击查看/切换"
      >
        租户 <span className="mono">{tenantId ?? '—'}</span>
      </button>
    </header>
  );
}
