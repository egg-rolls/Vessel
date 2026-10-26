/**
 * Gateway 状态页（0.25）：连接、端点、节点显示名、版本、启动时间 / 运行时长。
 *
 * 版本读取 `config.get` 的 additive `version`；旧 gateway 缺失时显示 `—`。
 * 节点展示名统一走 `useNodeNames`（health.get.node.name + sessionStorage 缓存），
 * 不在状态页展示原始 node_id。
 */
import { connectionLabel } from '../../app/connection-label';
import { useRefreshSignal } from '../../app/refresh';
import { PageHeader } from '../../components/PageHeader';
import { NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { useNodeNames } from '../nodes/useNodeNames';
import { uptimeParts } from './gateway-state';

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function GatewayView() {
  useLocale();
  const { client, connectionState, hasToken, epoch, tenantId, gatewayUrl } = useConnection();
  const { current } = useNodes();

  const { config, reloadConfig } = useConfigStoreApi();
  const health = useResource({
    load: () => client.getHealth(),
    enabled: hasToken,
    deps: [epoch, tenantId],
    pollMs: 15_000,
  });
  useRefreshSignal(() => {
    reloadConfig();
    health.reload();
  });

  const configData = resourceData(config);
  const healthData = resourceData(health.state);
  const providedNames = new Map(
    current && healthData?.node.name ? [[nodeKeyOf(current), healthData.node.name] as const] : [],
  );
  const nodeNames = useNodeNames(providedNames);
  const nodeName = current
    ? (nodeNames.get(nodeKeyOf(current)) ?? healthData?.node.name?.trim() ?? '—')
    : healthData?.node.name?.trim() || '—';
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
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={t('gateway.title')} tenantId={tenantId} />
      <div className="mt-5 flex flex-col gap-4">
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
                <dd>{nodeName}</dd>
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
              {config.status === 'error' && !configData && (
                <p className="field-error" role="alert">
                  {config.error}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
