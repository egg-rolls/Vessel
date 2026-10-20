import { useState } from 'react';
import { DomainIcon } from '../components/DomainIcon';
import { ModalShell } from '../components/Modal';
import { useConnection } from '../gateway/ConnectionProvider';
import { t, useLocale } from '../i18n';
import { primaryRoute } from './DomainNav';
import { DOMAINS, domainLabel, isDomainActive } from './nav';
import type { Route } from './router';

const BOTTOM_DOMAINS = DOMAINS.filter((domain) => domain.id !== 'observe');

/** <680px：底部 4 个主域 + More sheet（可观测 / 设置 / 连接身份）。 */
export function BottomNav({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  useLocale();
  const [moreOpen, setMoreOpen] = useState(false);
  const { tenantId, connectionState, hasToken } = useConnection();
  const moreActive = route.domain === 'observe' || route.domain === 'settings';
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
              <span>{domainLabel(domain.id)}</span>
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
