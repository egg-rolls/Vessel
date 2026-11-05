/**
 * Hub 状态页（0.25）：只展示 hub 自身状态与版本。
 *
 * - 状态来自 `config.get` 的 `hub` 段；版本来自同结果的 additive `version`；
 * - 节点列表、配对 / join 命令、Web 连接与 token 管理归 Nodes（DECISION-041）；
 * - hub 没有独立健康 RPC，也不代理正文。
 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { resourceData } from '../../state/useResource';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { type HubState, hubInfoFromConfig } from './hub-state';

/** HubState → i18n key 片段（catalog 用 notConfigured 驼峰）。 */
const STATE_KEYS: Record<HubState, string> = {
  not_configured: 'notConfigured',
  local: 'local',
  joined: 'joined',
};

export function HubView() {
  useLocale();
  const { hasToken } = useConnection();

  const { config, reloadConfig } = useConfigStoreApi();
  useRefreshSignal(reloadConfig);

  const configData = resourceData(config);
  const configError = config.status === 'error' && !configData ? config : null;
  const hubInfo = hubInfoFromConfig(configData?.config);
  const stateKey = STATE_KEYS[hubInfo.state];
  const stateLabel = t(`hub.state.${stateKey}`);
  const version = configData?.version;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('hub.title')} subtitle={t('hub.subtitle')}>
        {!hasToken ? (
          <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
        ) : configError ? (
          configError.code === 'forbidden' ? (
            <NotEnabledState title={t('hub.error.forbidden')} />
          ) : (
            <ErrorState message={configError.error} onRetry={reloadConfig} />
          )
        ) : !configData ? (
          <LoadingState label={t('common.loading')} />
        ) : (
          <div className="hub-view">
            <section className="panel hub-status">
              <dl className="diag-list">
                <dt>{t('hub.field.state')}</dt>
                <dd>
                  <StatusChip
                    status={hubInfo.state === 'not_configured' ? 'disabled' : 'connected'}
                    label={stateLabel}
                  />
                </dd>
                <dt>{t('hub.field.version')}</dt>
                <dd className="mono">{version ? `v${version}` : '—'}</dd>
                <dt>{t('hub.config.autoStart')}</dt>
                <dd>{hubInfo.autoStart ? t('hub.config.on') : t('hub.config.off')}</dd>
                {hubInfo.direction && (
                  <>
                    <dt>{t('hub.config.direction')}</dt>
                    <dd className="mono">{hubInfo.direction}</dd>
                  </>
                )}
                {hubInfo.url && (
                  <>
                    <dt>{t('hub.config.url')}</dt>
                    <dd className="mono">{hubInfo.url}</dd>
                  </>
                )}
                {hubInfo.listen && (
                  <>
                    <dt>{t('hub.config.listen')}</dt>
                    <dd className="mono">{hubInfo.listen}</dd>
                  </>
                )}
              </dl>
            </section>
          </div>
        )}
      </PageScaffold>
    </div>
  );
}
