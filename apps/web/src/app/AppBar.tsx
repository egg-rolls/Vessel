import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import { routeBreadcrumb } from './nav';
import type { Route } from './router';

function connectionLabel(state: string): string {
  switch (state) {
    case 'open':
      return t('nav.conn.online');
    case 'connecting':
      return t('nav.conn.connecting');
    case 'reconnecting':
      return t('nav.conn.reconnecting');
    case 'closed':
      return t('nav.conn.closed');
    case 'error':
      return t('nav.conn.error');
    default:
      return t('nav.conn.idle');
  }
}

export function AppBar({
  route,
  onOpenPalette,
  onToggleSessions,
  sessionsOpen = false,
  onToggleNav,
  navOpen = false,
  navigate,
}: {
  route: Route;
  onOpenPalette: () => void;
  onToggleSessions?: () => void;
  sessionsOpen?: boolean;
  onToggleNav?: () => void;
  navOpen?: boolean;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { connectionState, tenantId, hasToken } = useConnection();
  const connLabel = hasToken ? connectionLabel(connectionState) : t('nav.conn.idle');
  const drawerToggle = onToggleSessions
    ? {
        id: 'sessions-toggle',
        controls: 'chat-sessions',
        label: sessionsOpen ? t('nav.closeSessions') : t('nav.openSessions'),
        open: sessionsOpen,
        onClick: onToggleSessions,
      }
    : onToggleNav
      ? {
          id: 'nav-toggle',
          controls: 'domain-nav',
          label: navOpen ? t('nav.closeNav') : t('nav.openNav'),
          open: navOpen,
          onClick: onToggleNav,
        }
      : null;

  return (
    <header className="appbar">
      {drawerToggle && (
        <button
          id={drawerToggle.id}
          type="button"
          className="appbar-icon"
          aria-label={drawerToggle.label}
          aria-expanded={drawerToggle.open}
          aria-controls={drawerToggle.controls}
          onClick={drawerToggle.onClick}
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
        <span className="palette-trigger-text">{t('nav.searchOrCommand')}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>

      <button
        type="button"
        className={`conn conn-${hasToken ? connectionState : 'idle'}`}
        onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
        title={t('nav.connStatusTitle')}
      >
        <span className="conn-dot" aria-hidden="true" />
        <span>{connLabel}</span>
      </button>

      <button
        type="button"
        className="tenant-chip"
        onClick={() => navigate({ domain: 'settings', tab: 'tenants' })}
        title={t('nav.tenantChipTitle')}
      >
        {t('nav.tenant')} <span className="mono">{tenantId ?? '—'}</span>
      </button>
    </header>
  );
}
