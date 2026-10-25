import type { Ref } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { ResizeHandle } from '../components/ResizeHandle';
import { IconButton, Tooltip } from '../components/Tooltip';
import { cn } from '../components/ui/cn';
import { t, useLocale } from '../i18n';
import type { NavMode } from './layout';
import {
  DOMAINS,
  domainLabel,
  isDomainActive,
  NAV_GROUPS,
  navGroupLabel,
  type PrimaryDomain,
} from './nav';
import type { NavStatuses } from './nav-status';
import type { Domain, Route } from './router';
import { useNavStatus } from './useNavStatus';
import type { PaneResizeApi } from './usePaneResize';

export function primaryRoute(domain: Exclude<Domain, 'settings'>): Route {
  switch (domain) {
    case 'chat':
      return { domain: 'chat' };
    case 'hub':
      return { domain: 'hub' };
    case 'gateway':
      return { domain: 'gateway' };
    case 'nodes':
      return { domain: 'nodes' };
    case 'teams':
      return { domain: 'teams' };
    case 'agents':
      return { domain: 'agents' };
    case 'runs':
      return { domain: 'runs', tab: 'live' };
    case 'integrations':
      return { domain: 'integrations', tab: 'tools' };
    case 'observe':
      return { domain: 'observe', tab: 'metrics' };
  }
}

function domainDef(id: PrimaryDomain) {
  const entry = DOMAINS.find((domain) => domain.id === id);
  if (!entry) throw new Error(`unknown domain: ${id}`);
  return entry;
}

function statusOf(domain: PrimaryDomain, statuses: NavStatuses) {
  if (domain === 'hub') return statuses.hub;
  if (domain === 'gateway') return statuses.gateway;
  return null;
}

/** 展开 256px / 折叠 56px / 平板 64px rail / 移动抽屉。设置固定在底部。 */
export function DomainNav({
  route,
  navigate,
  mode,
  open = false,
  onClose,
  onToggleCollapsed,
  navRef,
  panes,
}: {
  route: Route;
  navigate: (route: Route) => void;
  mode: NavMode;
  open?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  navRef?: Ref<HTMLElement>;
  panes: PaneResizeApi;
}) {
  useLocale();
  const statuses = useNavStatus();
  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;
  const showCollapseToggle = mode === 'expanded' || mode === 'collapsed';
  const collapseLabel = collapsed ? t('nav.expandNav') : t('nav.collapseNav');
  const drawerA11y = drawer ? { role: 'dialog' as const, 'aria-modal': open } : {};
  const settingsLabel = domainLabel('settings');
  const itemClass = cn(
    'flex min-h-control w-full items-center rounded-sm bg-transparent text-left text-md text-muted transition-colors duration-150 hover:bg-hover hover:text-ink',
    collapsed ? 'justify-center gap-0 px-0 py-1' : 'gap-2.5 px-3 py-1',
  );
  const activeClass = 'bg-accent-soft text-accent-ink hover:bg-accent-soft hover:text-accent-ink';
  const settingsActive = route.domain === 'settings';
  const settingsButton = (
    <button
      type="button"
      className={cn(itemClass, settingsActive && activeClass)}
      aria-current={settingsActive ? 'page' : undefined}
      aria-label={settingsLabel}
      onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
    >
      <span className="inline-flex flex-none">
        <DomainIcon domain="settings" />
      </span>
      {showLabels && (
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {settingsLabel}
        </span>
      )}
    </button>
  );
  const navClass = cn(
    'flex flex-none flex-col bg-surface',
    drawer
      ? 'fixed inset-y-0 left-0 z-[var(--z-drawer)] min-h-0 w-[min(86vw,var(--drawer-w))] overflow-y-auto overscroll-contain shadow-elev-3 transition-[transform,visibility] duration-[var(--motion-ui)] ease-[var(--ease)]'
      : 'relative min-h-0 overflow-y-auto overscroll-contain',
    drawer &&
      (open ? 'visible translate-x-0 transition-[transform]' : 'invisible -translate-x-full'),
    !drawer &&
      (mode === 'collapsed'
        ? 'w-[var(--nav-w-collapsed)]'
        : mode === 'rail'
          ? 'w-[var(--nav-w-rail)]'
          : 'w-[var(--nav-w)]'),
  );

  return (
    <nav
      {...drawerA11y}
      ref={navRef}
      id="domain-nav"
      className={navClass}
      aria-label={t('nav.mainLabel')}
      inert={drawer && !open ? true : undefined}
      aria-hidden={drawer && !open ? true : undefined}
    >
      {mode !== 'rail' && (
        <div
          className={cn(
            'flex flex-none items-center gap-2 px-4 pt-3 pb-2',
            mode === 'collapsed' && 'justify-center gap-0.5 px-0',
          )}
        >
          <span className="font-serif text-xl font-semibold text-accent" aria-hidden="true">
            V
          </span>
          {showCollapseToggle && (
            <IconButton
              className={cn('size-6 text-xs', collapsed ? 'ml-0' : 'ml-auto')}
              label={collapseLabel}
              aria-label={collapseLabel}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? '»' : '«'}
            </IconButton>
          )}
          {drawer && (
            <IconButton
              className="ml-auto"
              label={t('nav.closeNav')}
              aria-label={t('nav.closeNav')}
              onClick={onClose}
            >
              ×
            </IconButton>
          )}
        </div>
      )}
      <div className={cn('flex flex-1 flex-col gap-0.5 py-1.5', collapsed ? 'px-2' : 'px-2.5')}>
        {NAV_GROUPS.map((group, index) => (
          <div className={cn('flex flex-col gap-0.5', index > 0 && 'mt-3')} key={group.id}>
            {showLabels && (
              <div className="overflow-hidden text-ellipsis whitespace-nowrap px-3 pt-1 pb-0.5 font-mono text-2xs tracking-[var(--tracking-wide)] text-faint uppercase">
                {navGroupLabel(group.id)}
              </div>
            )}
            {group.domains.map((domainId) => {
              const domain = domainDef(domainId);
              const active = isDomainActive(route, domain.id);
              const label = domainLabel(domain.id);
              const status = statusOf(domain.id, statuses);
              const statusText = status ? t(status.labelKey) : '';
              const versionText = status?.version ? `v${status.version}` : '—';
              const tooltip = status ? `${label} · ${statusText} · ${versionText}` : label;
              const button = (
                <button
                  key={domain.id}
                  type="button"
                  className={cn(itemClass, active && activeClass)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={label}
                  onClick={() => navigate(primaryRoute(domain.id))}
                >
                  <span className="inline-flex flex-none">
                    <DomainIcon domain={domain.id} />
                  </span>
                  {showLabels && (
                    <span
                      className={cn(
                        'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
                        status && 'flex-1',
                      )}
                    >
                      {label}
                    </span>
                  )}
                  {showLabels && status && (
                    <>
                      <span
                        className="size-1.5 flex-none rounded-full bg-faint data-[tone=ok]:bg-success data-[tone=warn]:bg-warn data-[tone=warn]:pulse-soft data-[tone=danger]:bg-danger"
                        data-tone={status.tone}
                        role="img"
                        aria-label={statusText}
                        title={statusText}
                      />
                      <span className="flex-none whitespace-nowrap font-mono text-2xs text-faint">
                        {versionText}
                      </span>
                    </>
                  )}
                </button>
              );
              return collapsed ? (
                <Tooltip key={domain.id} label={tooltip}>
                  {button}
                </Tooltip>
              ) : (
                button
              );
            })}
          </div>
        ))}
      </div>
      <div
        className={cn(
          'flex flex-none flex-col gap-0.5 px-2.5 pt-2 pb-[calc(var(--space-2)+env(safe-area-inset-bottom))]',
          collapsed && 'px-2',
        )}
      >
        {collapsed ? <Tooltip label={settingsLabel}>{settingsButton}</Tooltip> : settingsButton}
      </div>
      {mode === 'expanded' && !panes.disabled('nav') && (
        <ResizeHandle
          pane="nav"
          api={panes}
          label={t('resize.nav')}
          className="resize-handle resize-handle-nav"
        />
      )}
    </nav>
  );
}
