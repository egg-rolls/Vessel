/**
 * Nodes：列表（搜索 / Add node / 移除额外节点）+ 单节点详情。
 *
 * 列表按节点独立拉 `health.get`（状态 / 心跳 / 展示名）与 `teams.list`
 * （Team / Agent / 在线计数）；一个节点失败不影响其它节点。
 * 详情只读：健康与实例信息 + Teams / Agents 跳转，不再承载 Team CRUD。
 */
import { type ReactNode, useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { HealthResponse } from '../../gateway/types';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AddNodeDialog } from './AddNodeDialog';
import { matchesNodeQuery, nodeDisplayNames } from './display-names';
import { NodeDetailView } from './NodeDetailView';

type NodesRoute = Extract<Route, { domain: 'nodes' }>;

export interface NodePanelViewProps {
  route: NodesRoute;
  navigate: (route: Route) => void;
}

interface NodeHealthEntry {
  node: NodeView;
  health?: HealthResponse;
  error?: string;
  updatedAt?: number;
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NODES_POLL_MS = 15_000;
const NODE_TEAMS_POLL_MS = 20_000;

export function NodePanelView({ route, navigate }: NodePanelViewProps) {
  useLocale();
  const { tenantId } = useConnection();
  const { nodes } = useNodes();

  if (route.nodeKey !== undefined) {
    return <NodeDetailView nodeKey={route.nodeKey} navigate={navigate} />;
  }

  return <NodesList nodes={nodes} tenantId={tenantId} navigate={navigate} />;
}

function NodesList({
  nodes,
  tenantId,
  navigate,
}: {
  nodes: readonly NodeView[];
  tenantId: string | null;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { epoch } = useConnection();
  const { fetchHealth, removeNode } = useNodes();
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<NodeView | null>(null);

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const healthResource = useResource({
    // 逐节点 try/catch：一个节点不可达不拒绝整个列表。
    load: () =>
      Promise.all(
        nodes.map(async (node): Promise<NodeHealthEntry> => {
          try {
            const health = await fetchHealth(node);
            return { node, health, updatedAt: Date.now() };
          } catch (error) {
            return { node, error: messageOf(error) };
          }
        }),
      ),
    enabled: nodes.length > 0,
    pollMs: NODES_POLL_MS,
    deps: [epoch, nodeKeys],
  });

  const entries = resourceData(healthResource.state) ?? [];
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [nodeKeyOf(entry.node), entry])),
    [entries],
  );
  const displayNames = useMemo(
    () =>
      nodeDisplayNames(
        nodes.map((node) => {
          const entry = entryByKey.get(nodeKeyOf(node));
          const healthName = entry?.health?.node.name;
          return {
            key: nodeKeyOf(node),
            name: node.name,
            url: node.url,
            ...(node.nodeId ? { nodeId: node.nodeId } : {}),
            ...(healthName ? { healthName } : {}),
          };
        }),
        pageOrigin(),
      ),
    [nodes, entryByKey],
  );

  const visible = useMemo(
    () =>
      nodes.filter((node) => {
        const key = nodeKeyOf(node);
        return matchesNodeQuery(
          displayNames.get(key) ?? node.name,
          node.nodeId ?? key,
          node.name,
          query,
        );
      }),
    [nodes, displayNames, query],
  );

  const openNode = (node: NodeView) => navigate({ domain: 'nodes', nodeKey: nodeKeyOf(node) });

  let body: ReactNode;
  if (nodes.length === 0) {
    body = (
      <EmptyState
        title={t('nodes.empty')}
        action={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            {t('hub.add.title')}
          </Button>
        }
      />
    );
  } else if (healthResource.state.status === 'error' && entries.length === 0) {
    body = <ErrorState message={healthResource.state.error} onRetry={healthResource.reload} />;
  } else if (entries.length === 0) {
    body = <LoadingState label={t('common.loading')} rows={2} />;
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        title={t('nodes.emptyFiltered', { query: query.trim() })}
        action={
          <Button
            onClick={() => {
              setQuery('');
            }}
          >
            {t('team.list.clearSearch')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <ul className="net-list">
        {visible.map((node) => (
          <NodeRow
            key={nodeKeyOf(node)}
            node={node}
            displayName={displayNames.get(nodeKeyOf(node)) ?? node.name}
            entry={entryByKey.get(nodeKeyOf(node))}
            onOpen={() => openNode(node)}
            {...(node.current ? {} : { onRemove: () => setRemoveTarget(node) })}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="domain-view">
      <PageHeader
        title={t('nodes.title')}
        tenantId={tenantId}
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            {t('hub.add.title')}
          </Button>
        }
      />
      <div className="domain-content">
        {nodes.length > 0 && (
          <div className="filter-bar net-toolbar">
            <input
              className="input search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('nodes.search')}
              aria-label={t('nodes.search')}
              spellCheck={false}
            />
          </div>
        )}
        {body}
      </div>

      {addOpen && <AddNodeDialog onClose={() => setAddOpen(false)} />}

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

function NodeRow({
  node,
  displayName,
  entry,
  onOpen,
  onRemove,
}: {
  node: NodeView;
  displayName: string;
  entry: NodeHealthEntry | undefined;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  useLocale();
  const { epoch } = useConnection();
  const { fetchTeams } = useNodes();
  const key = nodeKeyOf(node);
  const teamsResource = useResource({
    load: () => fetchTeams(node),
    pollMs: NODE_TEAMS_POLL_MS,
    deps: [epoch, key],
  });
  const teams = resourceData(teamsResource.state);
  const summary = teams
    ? {
        teams: teams.length,
        agents: teams.reduce((sum, team) => sum + team.member_count, 0),
        online: teams.reduce((sum, team) => sum + (team.online_count ?? 0), 0),
      }
    : null;

  const status = entry?.health ? 'connected' : entry?.error ? 'unreachable' : 'pending';
  const statusLabelValue = entry?.health
    ? t('nodes.health.ok')
    : entry?.error
      ? t('nodes.health.error')
      : t('nodes.health.loading');
  const heartbeat = entry?.health
    ? t('hub.nodes.heartbeat', {
        time: formatTimestamp(entry.updatedAt) || t('nodes.health.loading'),
      })
    : entry?.error
      ? t('nodes.health.error')
      : t('nodes.health.loading');

  return (
    <li className="net-row net-node-row">
      <div className="net-row-main">
        <span className="net-row-title">
          {displayName}
          {node.current && <span className="net-badge">{t('nodes.current')}</span>}
        </span>
        <span className="net-row-sub mono">{displayGatewayUrl(node.url, pageOrigin())}</span>
      </div>
      <StatusChip status={status} label={statusLabelValue} />
      <div className="net-row-meta">
        <span>
          <strong>{summary ? summary.teams : '—'}</strong> {t('nodes.field.teams')}
        </span>
        <span>
          <strong>{summary ? summary.agents : '—'}</strong> {t('nodes.field.agents')}
        </span>
        <span>
          <strong>{summary ? summary.online : '—'}</strong> {t('nodes.field.online')}
        </span>
        <span className="net-row-sub">{heartbeat}</span>
      </div>
      <div className="net-row-actions">
        <Button size="small" onClick={onOpen}>
          {t('hub.nodes.open')}
        </Button>
        {onRemove && (
          <Button size="small" variant="dangerGhost" onClick={onRemove}>
            {t('common.remove')}
          </Button>
        )}
      </div>
    </li>
  );
}
