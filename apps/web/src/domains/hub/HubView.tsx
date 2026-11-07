/**
 * Hub 页（0.49 H4）：内置 Platform 页面，只展示 Hub 目录/状态。
 *
 * - Hub 由用户显式填写 URL + read token 后浏览器直连；页面不代理正文；
 * - 节点配对 / join / token 管理仍归 Nodes 与 CLI（DECISION-041）；
 * - 旧 `config.get.hub` 推导已下线：状态只来自 Hub client。
 */

import { PageScaffold } from '@vessel-agent/plugin-ui';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { HubConnectForm } from './HubConnectForm';
import { HubDirectory } from './HubDirectory';
import { useHubDirectory } from './useHubDirectory';

export function HubView() {
  useLocale();
  const hub = useHubDirectory();
  const origin = window.location.origin;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('hub.title')} subtitle={t('hub.subtitle')}>
        {hub.status === 'loading' ? (
          <LoadingState label={t('hub.directory.loading')} />
        ) : hub.status === 'connected' || hub.status === 'empty' ? (
          hub.directory !== null ? (
            <HubDirectory
              directory={hub.directory}
              url={hub.url}
              live={hub.live}
              reconnecting={hub.reconnecting}
              pointer={hub.pointer}
              onDisconnect={hub.disconnect}
              onRetry={hub.retry}
            />
          ) : (
            <EmptyState
              title={t('hub.directory.empty')}
              description={t('hub.directory.emptyHint')}
            />
          )
        ) : hub.status === 'incompatible' ? (
          <NotEnabledState
            title={t('hub.error.incompatible')}
            reason={t('hub.error.incompatibleReason')}
            action={
              <div className="flex flex-wrap gap-2">
                <Button onClick={hub.retry}>{t('common.retry')}</Button>
                <Button onClick={hub.disconnect}>{t('hub.connect.clear')}</Button>
              </div>
            }
          />
        ) : hub.status === 'network' ? (
          <ErrorState
            message={t('hub.error.origin', { origin })}
            onRetry={hub.retry}
            action={<Button onClick={hub.disconnect}>{t('hub.connect.clear')}</Button>}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {hub.status === 'unauthorized' && (
              <NotEnabledState
                title={t('hub.error.unauthorized')}
                reason={t('hub.error.unauthorizedReason')}
              />
            )}
            <HubConnectForm
              defaultUrl={hub.url}
              connecting={hub.connecting}
              error={hub.connectError}
              canClear={hub.url !== ''}
              onSubmit={(url, token) => {
                void hub.connect({ url, token });
              }}
              onClear={hub.disconnect}
            />
          </div>
        )}
      </PageScaffold>
    </div>
  );
}
