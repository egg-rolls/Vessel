/**
 * Gateway 状态页（0.25）：连接、端点、节点显示名、版本、启动时间 / 运行时长。
 *
 * 版本读取 `config.get` 的 additive `version`；旧 gateway 缺失时显示 `—`。
 * `health.get.node.name` 同为 additive，缺失时回退 node_id。
 */
import { connectionLabel } from '../../app/connection-label';
import { useRefreshSignal } from '../../app/refresh';
import { PageHeader } from '../../components/PageHeader';
import { NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { gatewayNodeName, uptimeParts } from './gateway-state';

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function GatewayView() {
  useLocale();
  const { client, connectionState, hasToken, epoch, tenantId, gatewayUrl } = useConnection();

  const config = useResource({
    load: () => client.getConfig(),
    enabled: hasToken,
    deps: [epoch, tenantId],
  });
  const health = useResource({
    load: () => client.getHealth(),
    enabled: hasToken,
    deps: [epoch, tenantId],
    pollMs: 15_000,
  });
  useRefreshSignal(() => {
    config.reload();
    health.reload();
  });

  const configData = resourceData(config.state);
  const healthData = resourceData(health.state);
  const healthFailed = health.state.status === 'error' && !healthData;
  const status = healthFailed ? 'unreachable' : healthData ? 'connected' : 'pending';
  const statusLabel = healthFailed
    ? t('gateway.state.error')
    : healthData
      ? t('gateway.state.ok')
      : t('gateway.state.connecting');
  const version = configData?.version;
  const uptime = uptimeParts(healthData?.node.started_at);

  return (
    <div className="domain-view">
      <PageHeader title={t('gateway.title')} tenantId={tenantId} />
      <div className="domain-content">
        {!hasToken ? (
          <NotEnabledState title={t('gateway.noToken')} reason={t('gateway.noTokenReason')} />
        ) : (
          <div className="hub-view">
            <section className="panel">
              <dl className="diag-list">
                <dt>{t('gateway.field.status')}</dt>
                <dd>
                  <StatusChip status={status} label={statusLabel} />
                </dd>
                <dt>{t('gateway.field.connection')}</dt>
                <dd>{connectionLabel(connectionState)}</dd>
                <dt>{t('gateway.field.endpoint')}</dt>
                <dd className="mono">
                  {healthData?.node.endpoint || displayGatewayUrl(gatewayUrl, pageOrigin())}
                </dd>
                <dt>{t('gateway.field.node')}</dt>
                <dd>{gatewayNodeName(healthData?.node)}</dd>
                <dt>{t('gateway.field.version')}</dt>
                <dd className="mono">{version ? `v${version}` : '—'}</dd>
                <dt>{t('gateway.field.startedAt')}</dt>
                <dd className="mono">
                  {healthData ? formatTimestamp(healthData.node.started_at) || '—' : '—'}
                </dd>
                <dt>{t('gateway.field.uptime')}</dt>
                <dd className="mono">{uptime ? t(uptime.key, uptime.params) : '—'}</dd>
              </dl>
              {health.state.status === 'error' && (
                <p className="field-error" role="alert">
                  {health.state.error}
                </p>
              )}
              {config.state.status === 'error' && !configData && (
                <p className="field-error" role="alert">
                  {config.state.error}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
