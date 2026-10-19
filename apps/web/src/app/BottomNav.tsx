import { useState } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { ModalShell } from '../components/Modal';
import { useConnection } from '../gateway/ConnectionProvider';
import { primaryRoute } from './DomainNav';
import { DOMAINS, isDomainActive } from './nav';
import type { Route } from './router';

const BOTTOM_DOMAINS = DOMAINS.filter((domain) => domain.id !== 'observe');

/** <680px：底部 4 个主域 + More sheet（可观测 / 设置 / 连接身份）。 */
export function BottomNav({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { tenantId, connectionState, hasToken } = useConnection();
  const moreActive = route.domain === 'observe' || route.domain === 'settings';

  return (
    <>
      <nav className="bottom-nav" aria-label="主导航（移动端）">
        {BOTTOM_DOMAINS.map((domain) => {
          const active = isDomainActive(route, domain.id);
          return (
            <button
              key={domain.id}
              type="button"
              className={`bottom-item ${active ? 'active' : ''}`.trim()}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(primaryRoute(domain.id))}
            >
              <DomainIcon domain={domain.id} />
              <span>{domain.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`bottom-item ${moreActive ? 'active' : ''}`.trim()}
          aria-current={moreActive ? 'page' : undefined}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="bottom-more-icon" aria-hidden="true">
            ⋯
          </span>
          <span>更多</span>
        </button>
      </nav>

      {moreOpen && (
        <ModalShell label="更多导航" onClose={() => setMoreOpen(false)} className="more-sheet">
          <h2 className="modal-title">更多</h2>
          <div className="more-list">
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMoreOpen(false);
                navigate({ domain: 'observe', tab: 'metrics' });
              }}
            >
              <DomainIcon domain="observe" /> 可观测
            </button>
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMoreOpen(false);
                navigate({ domain: 'settings', tab: 'connection' });
              }}
            >
              <DomainIcon domain="settings" /> 设置
            </button>
          </div>
          <div className="more-meta">
            <span>
              连接：
              {hasToken ? (connectionState === 'open' ? 'online' : connectionState) : '未连接'}
            </span>
            <span className="mono">租户 {tenantId ?? '—'}</span>
          </div>
        </ModalShell>
      )}
    </>
  );
}
