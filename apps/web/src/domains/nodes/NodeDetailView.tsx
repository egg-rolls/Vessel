/**
 * Node 详情：健康 / 实例信息 + 指向该节点 Teams / Agents 的只读入口。
 *
 * node_id 只在 Advanced details 出现一次；标题用人类可读展示名。
 * Team CRUD 已移到 Teams 域，本页不再写入。
 */
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { teamsForNodeHash } from '../teams/team-url';
import { baseNodeDisplayName } from './display-names';

export function NodeDetailView({
  nodeKey,
  navigate,
}: {
  nodeKey: string;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { epoch, tenantId, hello } = useConnection();
  const { nodes, fetchHealth } = useNodes();
  const node = nodes.find((item) => nodeKeyOf(item) === nodeKey);
  const health = useResource({
    load: () => {
      if (!node) throw new Error(t('nodes.notFound'));
      return fetchHealth(node);
    },
    enabled: node !== undefined,
    pollMs: 15_000,
    deps: [epoch, nodeKey],
  });

  if (!node) {
    return (
      <div className="domain-view">
        <PageHeader title={t('nodes.title')} tenantId={tenantId} />
        <div className="domain-content">
          <NotEnabledState
            title={t('nodes.notFound')}
            reason={t('nodes.notFoundHint')}
            action={
              <Button variant="primary" onClick={() => navigate({ domain: 'nodes' })}>
                {t('nodes.back')}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const healthData = resourceData(health.state);
  const displayName = baseNodeDisplayName(
    {
      name: node.name,
      url: node.url,
      ...(node.nodeId ? { nodeId: node.nodeId } : {}),
      ...(healthData?.node.name ? { healthName: healthData.node.name } : {}),
    },
    typeof window === 'undefined' ? '' : window.location.origin,
  );
  const status = healthData
    ? 'connected'
    : health.state.status === 'error'
      ? 'unreachable'
      : 'pending';
  const statusLabel = healthData
    ? t('nodes.health.ok')
    : health.state.status === 'error'
      ? t('nodes.health.error')
      : t('nodes.health.loading');
  const dataPlane = healthData
    ? t('nodes.dataPlane.direct')
    : health.state.status === 'error'
      ? t('nodes.dataPlane.unreachable')
      : t('nodes.health.loading');
  const heartbeat =
    health.state.status === 'success'
      ? formatTimestamp(health.state.updatedAt) || '—'
      : health.state.status === 'error'
        ? t('nodes.health.error')
        : t('nodes.health.loading');
  const nodeId = healthData?.node.node_id ?? node.nodeId ?? '—';
  const incarnation = node.current ? (hello?.incarnation ?? '—') : '—';

  return (
    <div className="domain-view">
      <PageHeader
        title={displayName}
        tenantId={tenantId}
        actions={
          <>
            <Button
              onClick={() => {
                window.location.hash = teamsForNodeHash(nodeKey);
              }}
            >
              {t('nodes.viewTeams')}
            </Button>
            <Button onClick={() => navigate({ domain: 'agents', nodeKey })}>
              {t('nodes.viewAgents')}
            </Button>
            <Button onClick={() => navigate({ domain: 'nodes' })}>{t('nodes.back')}</Button>
          </>
        }
      />
      <div className="domain-content">
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">{t('nodes.section.health')}</h2>
          </div>
          <dl className="diag-list">
            <dt>{t('nodes.field.status')}</dt>
            <dd>
              <StatusChip status={status} label={statusLabel} />
            </dd>
            <dt>{t('nodes.section.dataPlane')}</dt>
            <dd>{dataPlane}</dd>
            <dt>{t('nodes.lastHeartbeat')}</dt>
            <dd className="mono">{heartbeat}</dd>
          </dl>
          {health.state.status === 'error' && (
            <p className="field-error" role="alert">
              {health.state.error}
            </p>
          )}
        </section>

        <section className="panel">
          {healthData ? (
            <details className="net-advanced">
              <summary>{t('nodes.advanced')}</summary>
              <dl className="diag-list">
                <dt>{t('nodes.field.nodeId')}</dt>
                <dd className="mono">{nodeId}</dd>
                <dt>{t('nodes.field.endpoint')}</dt>
                <dd className="mono">{healthData.node.endpoint || '—'}</dd>
                <dt>{t('nodes.field.pid')}</dt>
                <dd className="mono">{healthData.node.pid}</dd>
                <dt>{t('nodes.field.startedAt')}</dt>
                <dd className="mono">{formatTimestamp(healthData.node.started_at) || '—'}</dd>
                <dt>{t('nodes.field.role')}</dt>
                <dd className="mono">{healthData.node.role}</dd>
                <dt>{t('nodes.field.protocol')}</dt>
                <dd className="mono">
                  {healthData.protocol.name} v{healthData.protocol.version}
                </dd>
                <dt>{t('nodes.field.incarnation')}</dt>
                <dd className="mono">{incarnation}</dd>
              </dl>
            </details>
          ) : health.state.status === 'error' ? (
            <ErrorState message={health.state.error} onRetry={health.reload} />
          ) : (
            <LoadingState label={t('nodes.health.loading')} rows={2} />
          )}
        </section>
      </div>
    </div>
  );
}
