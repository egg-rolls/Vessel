import type { Ref } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { useConnection } from '../gateway/ConnectionProvider';
import type { NavMode } from './layout';
import { DOMAINS, isDomainActive, NAV_GROUPS, type PrimaryDomain, SETTINGS_DOMAIN } from './nav';
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
  const { connectionState, hasToken, tenantId } = useConnection();
  const connLabel = !hasToken
    ? '未连接'
    : connectionState === 'open'
      ? 'online'
      : connectionState === 'reconnecting'
        ? '重连中'
        : connectionState === 'connecting'
          ? '连接中'
          : '已断开';
  const drawer = mode === 'drawer';
  const collapsed = mode === 'collapsed' || mode === 'rail';
  const showLabels = !collapsed;

  return (
    <nav
      ref={navRef}
      id="domain-nav"
      className={`domain-nav ${open ? 'open' : ''}`.trim()}
      aria-label="主导航"
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
            aria-label="关闭导航"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>
      <div className="nav-list">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            {showLabels && <div className="nav-group-title">{group.label}</div>}
            {group.domains.map((domainId) => {
              const domain = domainDef(domainId);
              const active = isDomainActive(route, domain.id);
              return (
                <button
                  key={domain.id}
                  type="button"
                  className={`nav-item ${active ? 'active' : ''}`.trim()}
                  aria-current={active ? 'page' : undefined}
                  aria-label={domain.label}
                  title={domain.label}
                  onClick={() => navigate(primaryRoute(domain.id))}
                >
                  <span className="nav-icon">
                    <DomainIcon domain={domain.id} />
                  </span>
                  <span className="nav-label">{domain.label}</span>
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
        <div className="nav-tenant nav-label" title="当前连接租户">
          <span className="mono">{tenantId ?? '—'}</span>
        </div>
        {(mode === 'expanded' || mode === 'collapsed') && (
          <button
            type="button"
            className="nav-item nav-collapse"
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            aria-expanded={!collapsed}
            title={collapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={onToggleCollapsed}
          >
            <span className="nav-icon" aria-hidden="true">
              {collapsed ? '»' : '«'}
            </span>
            <span className="nav-label">折叠</span>
          </button>
        )}
        <button
          type="button"
          className={`nav-item ${route.domain === 'settings' ? 'active' : ''}`.trim()}
          aria-current={route.domain === 'settings' ? 'page' : undefined}
          aria-label={SETTINGS_DOMAIN.label}
          title={SETTINGS_DOMAIN.label}
          onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
        >
          <span className="nav-icon">
            <DomainIcon domain="settings" />
          </span>
          <span className="nav-label">{SETTINGS_DOMAIN.label}</span>
        </button>
      </div>
    </nav>
  );
}
