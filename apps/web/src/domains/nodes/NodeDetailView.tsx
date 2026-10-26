/**
 * Node 详情：健康 / 实例信息 + 指向该节点 Teams / Agents 的只读入口。
 *
 * node_id 只在 Advanced details 出现一次；标题用人类可读展示名。
 * Team CRUD 已移到 Teams 域，本页不再写入。
 */
import { useEffect } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button, KeyValueList, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { nodeHealthEntry, useNodeStore } from '../../stores/nodeStore';
import { teamsForNodeHash } from '../teams/team-url';
import { useNodeNames } from './useNodeNames';

export function NodeDetailView({
  nodeKey,
  navigate,
}: {
  nodeKey: string;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { tenantId, hello } = useConnection();
  const { nodes, fetchHealth } = useNodes();
  const node = nodes.find((item) => nodeKeyOf(item) === nodeKey);
  const health = useNodeStore((state) => state.health);
  const select = useNodeStore((state) => state.select);
  const entry = node ? nodeHealthEntry(health, node) : undefined;
  const healthData = entry?.health;
  const healthError = entry?.error;

  useEffect(() => {
    select(nodeKey);
  }, [nodeKey, select]);

  const displayNames = useNodeNames();

  if (!node) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
        <PageHeader title={t('nodes.title')} tenantId={tenantId} />
        <div className="mt-5 flex flex-col gap-4">
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

  const displayName = displayNames.get(nodeKey) ?? '—';
  const status = healthData ? 'connected' : healthError ? 'unreachable' : 'pending';
  const statusLabel = healthData
    ? t('nodes.health.ok')
    : healthError
      ? t('nodes.health.error')
      : t('nodes.health.loading');
  const dataPlane = healthData
    ? t('nodes.dataPlane.direct')
    : healthError
      ? t('nodes.dataPlane.unreachable')
      : t('nodes.health.loading');
  const heartbeat = healthData
    ? formatTimestamp(entry?.updatedAt) || '—'
    : healthError
      ? t('nodes.health.error')
      : t('nodes.health.loading');
  const reloadHealth = () => {
    if (node) void useNodeStore.getState().loadHealth([node], fetchHealth);
  };
  const nodeId = healthData?.node.node_id ?? node.nodeId ?? '—';
  const incarnation = node.current ? (hello?.incarnation ?? '—') : '—';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
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
      <div className="mt-5 flex flex-col gap-4">
        <Section title={t('nodes.section.health')}>
          <KeyValueList
            items={[
              {
                key: 'status',
                label: t('nodes.field.status'),
                value: <StatusChip status={status} label={statusLabel} />,
              },
              {
                key: 'dataPlane',
                label: t('nodes.section.dataPlane'),
                value: dataPlane,
              },
              {
                key: 'heartbeat',
                label: t('nodes.lastHeartbeat'),
                value: <span className="font-mono">{heartbeat}</span>,
              },
            ]}
          />
          {healthError && (
            <p className="text-xs text-danger leading-snug" role="alert">
              {healthError}
            </p>
          )}
        </Section>

        <Section>
          {healthData ? (
            <details className="mt-3 border-t border-line pt-2">
              <summary className="cursor-pointer text-sm text-faint">{t('nodes.advanced')}</summary>
              <KeyValueList
                className="mt-2"
                items={[
                  {
                    key: 'nodeId',
                    label: t('nodes.field.nodeId'),
                    value: <span className="font-mono">{nodeId}</span>,
                  },
                  {
                    key: 'endpoint',
                    label: t('nodes.field.endpoint'),
                    value: <span className="font-mono">{healthData.node.endpoint || '—'}</span>,
                  },
                  {
                    key: 'pid',
                    label: t('nodes.field.pid'),
                    value: <span className="font-mono">{healthData.node.pid}</span>,
                  },
                  {
                    key: 'startedAt',
                    label: t('nodes.field.startedAt'),
                    value: (
                      <span className="font-mono">
                        {formatTimestamp(healthData.node.started_at) || '—'}
                      </span>
                    ),
                  },
                  {
                    key: 'role',
                    label: t('nodes.field.role'),
                    value: <span className="font-mono">{healthData.node.role}</span>,
                  },
                  {
                    key: 'protocol',
                    label: t('nodes.field.protocol'),
                    value: (
                      <span className="font-mono">
                        {healthData.protocol.name} v{healthData.protocol.version}
                      </span>
                    ),
                  },
                  {
                    key: 'incarnation',
                    label: t('nodes.field.incarnation'),
                    value: <span className="font-mono">{incarnation}</span>,
                  },
                ]}
              />
            </details>
          ) : healthError ? (
            <ErrorState message={healthError} onRetry={reloadHealth} />
          ) : (
            <LoadingState label={t('nodes.health.loading')} rows={2} />
          )}
        </Section>
      </div>
    </div>
  );
}
