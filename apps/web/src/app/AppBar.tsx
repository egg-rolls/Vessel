import { Tooltip } from '../components/Tooltip';
import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import { connectionLabel } from './connection-label';
import { LanguageToggle } from './LanguageToggle';
import { routeBreadcrumb } from './nav';
import type { Route } from './router';

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
    <header className="flex h-[var(--appbar-h)] flex-none items-center gap-3 bg-surface px-5 max-compact:gap-2 max-compact:px-3">
      {drawerToggle && (
        <Tooltip label={drawerToggle.label}>
          <button
            id={drawerToggle.id}
            type="button"
            className="hidden size-9 flex-none items-center justify-center rounded-full bg-transparent text-base text-muted transition-colors duration-150 hover:bg-hover max-wide:inline-flex pointer-coarse:size-touch"
            aria-label={drawerToggle.label}
            aria-expanded={drawerToggle.open}
            aria-controls={drawerToggle.controls}
            onClick={drawerToggle.onClick}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </Tooltip>
      )}
      <span className="font-serif text-xl font-semibold text-ink">Vessel</span>
      <span
        className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs tracking-wide text-faint max-compact:hidden"
        aria-live="polite"
      >
        {routeBreadcrumb(route)}
      </span>

      <div className="min-w-0 flex-1" />

      <LanguageToggle />

      <Tooltip label="Ctrl/Cmd+K">
        <button
          type="button"
          className="inline-flex min-w-45 items-center gap-2 rounded-full bg-sunken py-1.5 pl-3 pr-2 text-sm text-muted transition-colors duration-150 hover:bg-hover hover:text-ink max-compact:min-w-0 max-compact:px-2.5 pointer-coarse:min-h-touch"
          onClick={onOpenPalette}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span className="font-mono text-md" aria-hidden="true">
            ⌕
          </span>
          <span className="flex-1 text-left max-compact:hidden">{t('nav.searchOrCommand')}</span>
          <kbd className="kbd max-compact:hidden">⌘K</kbd>
        </button>
      </Tooltip>

      <Tooltip label={t('nav.connStatusTitle')}>
        <button
          type="button"
          className="group inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-transparent px-2.5 py-1 text-xs tracking-wide text-muted transition-colors duration-150 hover:bg-hover data-[state=open]:text-success data-[state=connecting]:text-warn data-[state=reconnecting]:text-warn data-[state=closed]:text-danger data-[state=error]:text-danger max-compact:px-2 pointer-coarse:min-h-touch"
          data-state={hasToken ? connectionState : 'idle'}
          onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
        >
          <span
            className="size-1.5 flex-none rounded-full bg-faint group-data-[state=open]:bg-success group-data-[state=connecting]:bg-warn group-data-[state=connecting]:pulse-soft group-data-[state=reconnecting]:bg-warn group-data-[state=reconnecting]:pulse-soft group-data-[state=closed]:bg-danger group-data-[state=error]:bg-danger"
            aria-hidden="true"
          />
          <span className="max-compact:hidden">{connLabel}</span>
        </button>
      </Tooltip>

      <Tooltip label={t('nav.tenantChipTitle')}>
        <button
          type="button"
          className="rounded-full bg-transparent px-2.5 py-1 text-xs whitespace-nowrap text-muted transition-colors duration-150 hover:bg-hover hover:text-ink max-compact:hidden pointer-coarse:min-h-touch"
          onClick={() => navigate({ domain: 'settings', tab: 'tenants' })}
        >
          {t('nav.tenant')} <span className="mono">{tenantId ?? '—'}</span>
        </button>
      </Tooltip>
    </header>
  );
}
