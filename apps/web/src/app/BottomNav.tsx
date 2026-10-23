import { useState } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { ModalShell } from '../components/Modal';
import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import { primaryRoute } from './DomainNav';
import { domainLabel, isDomainActive, type PrimaryDomain } from './nav';
import type { Route } from './router';

/** 移动端常驻 3 项；Team 放进 More sheet，避免出现第 6 个常驻按钮。 */
const BOTTOM_DOMAINS: readonly PrimaryDomain[] = ['chat', 'runs', 'integrations'];

/** <680px：底部 3 个主域 + More sheet（可观测 / 设置 / 连接身份）。 */
export function BottomNav({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  useLocale();
  const [moreOpen, setMoreOpen] = useState(false);
  const { tenantId, connectionState, hasToken } = useConnection();
  const moreActive =
    route.domain === 'observe' || route.domain === 'settings' || route.domain === 'team';
  const connLabel = !hasToken
    ? t('nav.conn.idle')
    : connectionState === 'open'
      ? t('nav.conn.online')
      : connectionState === 'reconnecting'
        ? t('nav.conn.reconnectingShort')
        : connectionState === 'connecting'
          ? t('nav.conn.connectingShort')
          : t('nav.conn.closed');

  return (
    <>
      <nav className="bottom-nav" aria-label={t('nav.bottomLabel')}>
        {BOTTOM_DOMAINS.map((domainId) => {
          const active = isDomainActive(route, domainId);
          return (
            <button
              key={domainId}
              type="button"
              className={`bottom-item ${active ? 'active' : ''}`.trim()}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(primaryRoute(domainId))}
            >
              <DomainIcon domain={domainId} />
              <span>{domainLabel(domainId)}</span>
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
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {moreOpen && (
        <ModalShell
          label={t('nav.moreSheet')}
          onClose={() => setMoreOpen(false)}
          className="more-sheet"
        >
          <h2 className="modal-title">{t('nav.more')}</h2>
          <div className="more-list">
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMoreOpen(false);
                navigate({ domain: 'team' });
              }}
            >
              <DomainIcon domain="team" /> {domainLabel('team')}
            </button>
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMoreOpen(false);
                navigate({ domain: 'observe', tab: 'metrics' });
              }}
            >
              <DomainIcon domain="observe" /> {domainLabel('observe')}
            </button>
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMoreOpen(false);
                navigate({ domain: 'settings', tab: 'connection' });
              }}
            >
              <DomainIcon domain="settings" /> {domainLabel('settings')}
            </button>
          </div>
          <div className="more-meta">
            <span>{t('nav.connectionNamed', { value: connLabel })}</span>
            <span className="mono">{t('nav.tenantNamed', { tenant: tenantId ?? '—' })}</span>
          </div>
        </ModalShell>
      )}
    </>
  );
}
