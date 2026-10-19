import { DomainIcon } from '../components/DomainIcon';
import { useConnection } from '../gateway/ConnectionProvider';
import { DOMAINS, isDomainActive, SETTINGS_DOMAIN } from './nav';
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

/** 桌面 224px / 平板 64px 图标 rail；设置固定在底部。 */
export function DomainNav({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
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

  return (
    <nav className="domain-nav" aria-label="主导航">
      <div className="nav-brand" aria-hidden="true">
        <span className="nav-brand-mark">V</span>
      </div>
      <div className="nav-list">
        {DOMAINS.map((domain) => {
          const active = isDomainActive(route, domain.id);
          return (
            <button
              key={domain.id}
              type="button"
              className={`nav-item ${active ? 'active' : ''}`.trim()}
              aria-current={active ? 'page' : undefined}
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
      <div className="nav-footer">
        <div className={`nav-conn nav-conn-${hasToken ? connectionState : 'idle'}`}>
          <span className="conn-dot" aria-hidden="true" />
          <span className="nav-label">{connLabel}</span>
        </div>
        <div className="nav-tenant nav-label" title="当前连接租户">
          <span className="mono">{tenantId ?? '—'}</span>
        </div>
        <button
          type="button"
          className={`nav-item ${route.domain === 'settings' ? 'active' : ''}`.trim()}
          aria-current={route.domain === 'settings' ? 'page' : undefined}
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
