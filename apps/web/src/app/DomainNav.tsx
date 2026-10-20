import type { Ref } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { useConnection } from '../gateway/ConnectionProvider';
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

export function primaryRoute(domain: Exclude<Domain, 'settings'>): Route {
  switch (domain) {
    case 'chat':
      return { domain: 'chat' };
    case 'runs':
      return { domain: 'runs', tab: 'live' };
    case 'workflows':
      return { domain: 'workflows' };
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
}: {
  route: Route;
  navigate: (route: Route) => void;
  mode: NavMode;
  open?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  navRef?: Ref<HTMLElement>;
}) {
  useLocale();
  const { connectionState, hasToken, tenantId } = useConnection();
  const connLabel = !hasToken
    ? t('nav.conn.idle')
    : connectionState === 'open'
      ? t('nav.conn.online')
      : connectionState === 'reconnecting'
        ? t('nav.conn.reconnectingShort')
        : connectionState === 'connecting'
          ? t('nav.conn.connectingShort')
          : t('nav.conn.closed');
  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;
  const drawerA11y = drawer ? { role: 'dialog' as const, 'aria-modal': open } : {};

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
        {drawer && (
          <button
            type="button"
            className="icon-btn nav-close"
            aria-label={t('nav.closeNav')}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>
      <div className="nav-list">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            {showLabels && <div className="nav-group-title">{navGroupLabel(group.id)}</div>}
            {group.domains.map((domainId) => {
              const domain = domainDef(domainId);
              const active = isDomainActive(route, domain.id);
              return (
                <button
                  key={domain.id}
                  type="button"
                  className={`nav-item ${active ? 'active' : ''}`.trim()}
                  aria-current={active ? 'page' : undefined}
                  aria-label={domainLabel(domain.id)}
                  title={domainLabel(domain.id)}
                  onClick={() => navigate(primaryRoute(domain.id))}
                >
                  <span className="nav-icon">
                    <DomainIcon domain={domain.id} />
                  </span>
                  <span className="nav-label">{domainLabel(domain.id)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="nav-footer">
        <div className={`nav-conn nav-conn-${hasToken ? connectionState : 'idle'}`}>
          <span className="conn-dot" aria-hidden="true" />
          <span className="nav-label">{connLabel}</span>
        </div>
        <div className="nav-tenant nav-label" title={t('nav.tenantCurrent')}>
          <span className="mono">{tenantId ?? '—'}</span>
        </div>
        {(mode === 'expanded' || mode === 'collapsed') && (
          <button
            type="button"
            className="nav-item nav-collapse"
            aria-label={collapsed ? t('nav.expandNav') : t('nav.collapseNav')}
            aria-expanded={!collapsed}
            title={collapsed ? t('nav.expandNav') : t('nav.collapseNav')}
            onClick={onToggleCollapsed}
          >
            <span className="nav-icon" aria-hidden="true">
              {collapsed ? '»' : '«'}
            </span>
            <span className="nav-label">{t('nav.collapsed')}</span>
          </button>
        )}
        <button
          type="button"
          className={`nav-item ${route.domain === 'settings' ? 'active' : ''}`.trim()}
          aria-current={route.domain === 'settings' ? 'page' : undefined}
          aria-label={domainLabel('settings')}
          title={domainLabel('settings')}
          onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
        >
          <span className="nav-icon">
            <DomainIcon domain="settings" />
          </span>
          <span className="nav-label">{domainLabel('settings')}</span>
        </button>
      </div>
    </nav>
  );
}
