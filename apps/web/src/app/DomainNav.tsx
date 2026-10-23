import type { Ref } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { ResizeHandle } from '../components/ResizeHandle';
import { IconButton, Tooltip } from '../components/Tooltip';
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
import type { Domain, Route } from './router';
import type { PaneResizeApi } from './usePaneResize';

export function primaryRoute(domain: Exclude<Domain, 'settings'>): Route {
  switch (domain) {
    case 'chat':
      return { domain: 'chat' };
    case 'team':
      return { domain: 'team' };
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
  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;
  const showCollapseToggle = mode === 'expanded' || mode === 'collapsed';
  const collapseLabel = collapsed ? t('nav.expandNav') : t('nav.collapseNav');
  const drawerA11y = drawer ? { role: 'dialog' as const, 'aria-modal': open } : {};
  const settingsLabel = domainLabel('settings');
  const settingsButton = (
    <button
      type="button"
      className={`nav-item ${route.domain === 'settings' ? 'active' : ''}`.trim()}
      aria-current={route.domain === 'settings' ? 'page' : undefined}
      aria-label={settingsLabel}
      onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
    >
      <span className="nav-icon">
        <DomainIcon domain="settings" />
      </span>
      <span className="nav-label">{settingsLabel}</span>
    </button>
  );

  return (
    <nav
      {...drawerA11y}
      ref={navRef}
      id="domain-nav"
      className={`domain-nav ${open ? 'open' : ''}`.trim()}
      aria-label={t('nav.mainLabel')}
      inert={drawer && !open ? true : undefined}
      aria-hidden={drawer && !open ? true : undefined}
    >
      <div className="nav-brand">
        <span className="nav-brand-mark" aria-hidden="true">
          V
        </span>
        {showCollapseToggle && (
          <IconButton
            className="nav-collapse"
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
            className="nav-close"
            label={t('nav.closeNav')}
            aria-label={t('nav.closeNav')}
            onClick={onClose}
          >
            ×
          </IconButton>
        )}
      </div>
      <div className="nav-list">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            {showLabels && <div className="nav-group-title">{navGroupLabel(group.id)}</div>}
            {group.domains.map((domainId) => {
              const domain = domainDef(domainId);
              const active = isDomainActive(route, domain.id);
              const label = domainLabel(domain.id);
              const button = (
                <button
                  key={domain.id}
                  type="button"
                  className={`nav-item ${active ? 'active' : ''}`.trim()}
                  aria-current={active ? 'page' : undefined}
                  aria-label={label}
                  onClick={() => navigate(primaryRoute(domain.id))}
                >
                  <span className="nav-icon">
                    <DomainIcon domain={domain.id} />
                  </span>
                  <span className="nav-label">{label}</span>
                </button>
              );
              return collapsed ? (
                <Tooltip key={domain.id} label={label}>
                  {button}
                </Tooltip>
              ) : (
                button
              );
            })}
          </div>
        ))}
      </div>
      <div className="nav-footer">
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
