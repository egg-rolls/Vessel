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
import { Badge, Button, SearchInput } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { HealthResponse } from '../../gateway/types';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AddNodeDialog } from './AddNodeDialog';
import { matchesNodeQuery } from './display-names';
import { NodeDetailView } from './NodeDetailView';
import { useNodeNames } from './useNodeNames';

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
  const healthNames = useMemo(
    () =>
      new Map(
        entries.flatMap((entry) =>
          entry.health?.node.name ? [[nodeKeyOf(entry.node), entry.health.node.name]] : [],
        ),
      ),
    [entries],
  );
  const displayNames = useNodeNames(healthNames);

  const visible = useMemo(
    () =>
      nodes.filter((node) => {
        const key = nodeKeyOf(node);
        return matchesNodeQuery(displayNames.get(key) ?? '—', node.nodeId ?? key, node.name, query);
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
      <ul className="flex flex-col gap-2">
        {visible.map((node) => (
          <NodeRow
            key={nodeKeyOf(node)}
            node={node}
            displayName={displayNames.get(nodeKeyOf(node)) ?? '—'}
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
          <div className="net-toolbar mt-3.5">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('nodes.search')}
              ariaLabel={t('nodes.search')}
              className="grow basis-60 max-w-search"
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
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-raised px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-55 flex-col gap-0.5">
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-md font-semibold text-ink">
          {displayName}
          {node.current && <Badge tone="accent">{t('nodes.current')}</Badge>}
        </span>
        <span className="min-w-0 wrap-anywhere font-mono text-xs text-faint">
          {displayGatewayUrl(node.url, pageOrigin())}
        </span>
      </div>
      <StatusChip status={status} label={statusLabelValue} />
      <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-sm tabular-nums text-muted">
        <span>
          <strong className="font-semibold text-ink">{summary ? summary.teams : '—'}</strong>{' '}
          {t('nodes.field.teams')}
        </span>
        <span>
          <strong className="font-semibold text-ink">{summary ? summary.agents : '—'}</strong>{' '}
          {t('nodes.field.agents')}
        </span>
        <span>
          <strong className="font-semibold text-ink">{summary ? summary.online : '—'}</strong>{' '}
          {t('nodes.field.online')}
        </span>
        <span className="min-w-0 wrap-anywhere text-xs text-faint">{heartbeat}</span>
      </div>
      <div className="ml-auto inline-flex flex-none flex-wrap items-center gap-2">
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
