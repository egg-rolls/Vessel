/**
 * Hub 域（0.24 Web IA）：hub 三态 + 节点卡片 + Add node 的 CLI 命令。
 *
 * - hub 状态来自 `config.get` 的 `hub` 段，不新增 hub 健康 RPC；
 * - 节点健康 / Team 计数来自既有 `health.get` / `teams.list`（经 NodeProvider）；
 * - hub 只做目录与指针，Web 不代理正文，也不在页面内配对 hub（DECISION-039）。
 */
import { useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyButton } from '../../components/CopyButton';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { type HubState, hubInfoFromConfig } from './hub-state';

type HubRoute = Extract<Route, { domain: 'hub' }>;

/** HubState → i18n key 片段（catalog 用 notConfigured 驼峰）。 */
const STATE_KEYS: Record<HubState, string> = {
  not_configured: 'notConfigured',
  local: 'local',
  joined: 'joined',
};

/** Add node 四组命令；第 4 组本身就是命令，不重复标签。 */
const ADD_COMMANDS: readonly { id: string; label?: string; command: string }[] = [
  { id: 'pair', label: 'hub.add.pairNode', command: 'hub.add.pairCommand' },
  { id: 'add', label: 'hub.add.addToHub', command: 'hub.add.addCommand' },
  { id: 'join-code', label: 'hub.add.joinCode', command: 'hub.add.joinCodeCommand' },
  { id: 'join', command: 'hub.add.joinCommand' },
];

function NodeCard({
  node,
  onOpen,
  onRemove,
}: {
  node: NodeView;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  useLocale();
  const { epoch } = useConnection();
  const { fetchHealth, fetchTeams } = useNodes();

  const health = useResource({
    load: () => fetchHealth(node),
    deps: [node.name, node.url, epoch],
    pollMs: 15_000,
  });
  const teams = useResource({
    load: () => fetchTeams(node),
    deps: [node.name, node.url, epoch],
    pollMs: 30_000,
  });

  const info = resourceData(health.state);
  const teamsData = resourceData(teams.state);
  const healthFailed = health.state.status === 'error';
  const summary = teamsData
    ? {
        teams: teamsData.length,
        agents: teamsData.reduce((sum, team) => sum + team.member_count, 0),
        online: teamsData.reduce((sum, team) => sum + (team.online_count ?? 0), 0),
      }
    : null;
  const heartbeat =
    health.state.status === 'success'
      ? t('hub.nodes.heartbeat', { time: formatTimestamp(health.state.updatedAt) })
      : t('hub.nodes.unknownHealth');
  const nodeId = info?.node.node_id ?? node.nodeId ?? '—';

  return (
    <div className="hub-node-card">
      <div className="hub-node-head">
        <span className="hub-node-name">{node.name}</span>
        {node.current && <span className="hub-node-badge">{t('hub.nodes.current')}</span>}
        {(info || healthFailed) && <StatusChip status={info?.status ?? 'unreachable'} />}
      </div>
      <div className="hub-node-meta mono">
        <span>{nodeId}</span>
        <span>{summary ? t('hub.nodes.summary', summary) : t('hub.config.unknown')}</span>
        <span className="dim">{heartbeat}</span>
      </div>
      <div className="hub-node-actions">
        <button type="button" className="btn btn-small" onClick={onOpen}>
          {t('hub.nodes.open')}
        </button>
        {onRemove && (
          <button type="button" className="btn btn-small btn-danger-ghost" onClick={onRemove}>
            {t('hub.nodes.remove')}
          </button>
        )}
      </div>
    </div>
  );
}

export function HubView({ navigate }: { route: HubRoute; navigate: (route: Route) => void }) {
  useLocale();
  const { client, hasToken, epoch, tenantId } = useConnection();
  const { nodes, removeNode } = useNodes();
  const [removeTarget, setRemoveTarget] = useState<NodeView | null>(null);

  const config = useResource({
    load: () => client.getConfig(),
    enabled: hasToken,
    deps: [epoch],
  });
  useRefreshSignal(config.reload);
  const configData = resourceData(config.state);
  const configError = config.state.status === 'error' && !configData ? config.state : null;
  const hubInfo = hubInfoFromConfig(configData?.config);
  const stateKey = STATE_KEYS[hubInfo.state];

  return (
    <div className="domain-view">
      <PageHeader title={t('hub.title')} description={t('hub.description')} tenantId={tenantId} />
      <div className="domain-content">
        {!hasToken ? (
          <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
        ) : configError ? (
          configError.code === 'forbidden' ? (
            <NotEnabledState title={t('hub.error.forbidden')} />
          ) : (
            <ErrorState message={configError.error} onRetry={config.reload} />
          )
        ) : !configData ? (
          <LoadingState label={t('common.loading')} />
        ) : (
          <div className="hub-view">
            <section className="panel hub-status">
              <div className="panel-header">
                <h2 className="section-title">{t(`hub.state.${stateKey}`)}</h2>
              </div>
              <p className="section-desc">{t(`hub.state.${stateKey}Hint`)}</p>
              <dl className="diag-list">
                <dt>{t('hub.config.autoStart')}</dt>
                <dd>{hubInfo.autoStart ? t('hub.config.on') : t('hub.config.off')}</dd>
                <dt>{t('hub.config.direction')}</dt>
                <dd>{hubInfo.direction ?? t('hub.config.unknown')}</dd>
                <dt>{t('hub.config.url')}</dt>
                <dd className="mono">{hubInfo.url ?? t('hub.config.unknown')}</dd>
                <dt>{t('hub.config.listen')}</dt>
                <dd className="mono">{hubInfo.listen ?? t('hub.config.unknown')}</dd>
              </dl>
              <p className="dim">{t('hub.healthNote')}</p>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2 className="section-title">{t('hub.nodes.title')}</h2>
                <span className="count-pill">{nodes.length}</span>
              </div>
              {nodes.length === 0 ? (
                <EmptyState title={t('hub.nodes.empty')} description={t('hub.nodes.emptyHint')} />
              ) : (
                <div className="hub-node-list">
                  {nodes.map((node) => (
                    <NodeCard
                      key={`${node.current ? 'current' : 'extra'}:${node.name}`}
                      node={node}
                      onOpen={() => navigate({ domain: 'nodes', nodeKey: nodeKeyOf(node) })}
                      {...(node.current ? {} : { onRemove: () => setRemoveTarget(node) })}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2 className="section-title">{t('hub.add.title')}</h2>
              </div>
              <p className="section-desc">{t('hub.add.description')}</p>
              <div className="hub-add-list">
                {ADD_COMMANDS.map((row) => (
                  <div className="hub-add-row" key={row.id}>
                    {row.label && <span className="hub-add-label">{t(row.label)}</span>}
                    <code className="hub-add-command mono">{t(row.command)}</code>
                    <CopyButton
                      text={t(row.command)}
                      label={t('common.copy')}
                      toast={t('common.copied')}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="link-btn hub-add-connection"
                onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
              >
                {t('hub.add.openConnection')}
              </button>
            </section>
          </div>
        )}
      </div>

      {removeTarget && (
        <ConfirmDialog
          title={t('hub.remove.title')}
          body={<p>{t('hub.remove.body')}</p>}
          confirmLabel={t('common.remove')}
          danger
          onConfirm={() => {
            removeNode(removeTarget.name);
            setRemoveTarget(null);
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
