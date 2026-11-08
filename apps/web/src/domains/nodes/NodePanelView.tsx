/**
 * Nodes：列表（搜索 / Add node / 移除额外节点）+ 单节点详情。
 *
 * 列表按节点独立拉 `health.get`（状态 / 心跳 / 展示名）与 `teams.list`
 * （Team / Agent / 在线计数）；一个节点失败不影响其它节点。
 * 详情只读：健康与实例信息 + Teams / Agents 跳转，不再承载 Team CRUD。
 */
import { PageScaffold, TableToolbar } from '@vessel-agent/plugin-ui';
import { type ReactNode, useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, LoadingState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button, SearchInput } from '../../components/ui';
import { CARD_SURFACE_CLASS } from '../../components/ui/card-surface';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { type NodeHealthEntry, nodeHealthEntry, useNodeStore } from '../../stores/nodeStore';
import { teamListData, useTeamListState, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { AddNodeDialog } from './AddNodeDialog';
import { matchesNodeQuery } from './display-names';
import { NodeDetailView } from './NodeDetailView';
import { nodeStatusKind, nodeStatusLabel } from './node-status';
import { useNodeNames } from './useNodeNames';

type NodesRoute = Extract<Route, { domain: 'nodes' }>;

export interface NodePanelViewProps {
  route: NodesRoute;
  navigate: (route: Route) => void;
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

const NODE_TEAMS_POLL_MS = 20_000;

export function NodePanelView({ route, navigate }: NodePanelViewProps) {
  useLocale();
  const { nodes } = useNodes();

  if (route.nodeKey !== undefined) {
    return <NodeDetailView nodeKey={route.nodeKey} navigate={navigate} />;
  }

  return <NodesList nodes={nodes} navigate={navigate} />;
}

function NodesList({
  nodes,
  navigate,
}: {
  nodes: readonly NodeView[];
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { removeNode } = useNodes();
  const { mode, nodeSelection, selectPlatformNode } = useConnection();
  const platformMode = mode === 'platform';
  const health = useNodeStore((state) => state.health);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<NodeView | null>(null);

  const entries = nodes
    .map((node) => nodeHealthEntry(health, node))
    .filter((entry): entry is NodeHealthEntry => entry !== undefined);
  const loaded =
    nodes.length > 0 &&
    nodes.every((node) => {
      const entry = nodeHealthEntry(health, node);
      // 平台节点可能只有 `nodes.list.status`（非当前节点不做 health.get 探测）。
      return entry?.health !== undefined || entry?.error !== undefined || node.status !== undefined;
    });
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [nodeKeyOf(entry.node), entry])),
    [entries],
  );
  const displayNames = useNodeNames();
  const currentNode = nodes.find((node) => node.current);

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
    body = platformMode ? (
      <EmptyState title={t('nodes.platform.empty')} />
    ) : (
      <EmptyState
        title={t('nodes.empty')}
        action={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            {t('hub.add.title')}
          </Button>
        }
      />
    );
  } else if (!loaded) {
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
      <ul className="entity-card-grid">
        {visible.map((node) => (
          <NodeRow
            key={nodeKeyOf(node)}
            node={node}
            displayName={displayNames.get(nodeKeyOf(node)) ?? '—'}
            entry={entryByKey.get(nodeKeyOf(node))}
            platformMode={platformMode}
            onOpen={() => openNode(node)}
            {...(node.current
              ? {}
              : platformMode
                ? {
                    onSelect: () => {
                      if (node.nodeId) selectPlatformNode(node.nodeId);
                    },
                  }
                : { onRemove: () => setRemoveTarget(node) })}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('nodes.title')} subtitle={t('nodes.subtitle')}>
        {platformMode && nodeSelection.fallback !== null && currentNode && (
          <p className="mb-3 text-sm text-warn" role="status">
            {t(`nodes.selection.fallback.${nodeSelection.fallback}`, {
              node: displayNames.get(nodeKeyOf(currentNode)) ?? currentNode.name,
            })}
          </p>
        )}
        {nodes.length > 0 && (
          <TableToolbar label={t('nodes.search')}>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('nodes.search')}
              ariaLabel={t('nodes.search')}
              className="grow basis-60 max-w-search"
            />
            {!platformMode && (
              <Button variant="primary" className="ml-auto" onClick={() => setAddOpen(true)}>
                {t('hub.add.title')}
              </Button>
            )}
          </TableToolbar>
        )}
        {body}
      </PageScaffold>

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
  platformMode,
  onOpen,
  onRemove,
  onSelect,
}: {
  node: NodeView;
  displayName: string;
  entry: NodeHealthEntry | undefined;
  platformMode: boolean;
  onOpen: () => void;
  onRemove?: () => void;
  onSelect?: () => void;
}) {
  useLocale();
  const { epoch } = useConnection();
  const { teamControl } = useNodes();
  const key = nodeKeyOf(node);
  const listState = useTeamListState(node);
  const loadList = useTeamStore((state) => state.loadList);
  // Nodes 列表只为当前节点轮询 teams.list；其它节点的健康/状态由 nodes.list
  // 提供，跨节点页面按需用各自 token 拉取，避免 N 个后台轮询。
  usePolledAction(
    () => {
      void loadList(node, teamControl(node));
    },
    {
      enabled: !platformMode || node.current,
      pollMs: NODE_TEAMS_POLL_MS,
      deps: [epoch, key],
    },
  );
  const teams = teamListData(listState)?.teams;
  const summary = teams
    ? {
        teams: teams.length,
        agents: teams.reduce((sum, team) => sum + team.member_count, 0),
        online: teams.reduce((sum, team) => sum + (team.online_count ?? 0), 0),
      }
    : null;

  const status = nodeStatusKind(entry, node);
  const statusLabelValue = nodeStatusLabel(entry, node);
  const heartbeat = entry?.health
    ? t('hub.nodes.heartbeat', {
        time: formatTimestamp(entry.updatedAt) || t('nodes.health.loading'),
      })
    : entry?.error
      ? t('nodes.health.error')
      : '';

  return (
    <li className="min-w-0">
      <button type="button" className={CARD_SURFACE_CLASS} onClick={onOpen}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-md font-semibold text-ink">
            {displayName}
            {node.current && (
              <span className="text-2xs text-faint" title={t('entity.currentNode')}>
                <span aria-hidden="true">· </span>
                {t('entity.currentNode')}
              </span>
            )}
          </span>
          <span className="min-w-0 wrap-anywhere font-mono text-xs text-faint">
            {displayGatewayUrl(node.url, pageOrigin())}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm tabular-nums text-muted">
          <StatusChip status={status} label={statusLabelValue} />
          {(!platformMode || node.current) && (
            <>
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
            </>
          )}
        </div>
        {heartbeat !== '' && (
          <span className="min-w-0 wrap-anywhere text-xs text-faint">{heartbeat}</span>
        )}
      </button>
      {onRemove && (
        <Button size="small" variant="dangerGhost" className="mt-1.5 ml-4" onClick={onRemove}>
          {t('common.remove')}
        </Button>
      )}
      {onSelect && (
        <Button size="small" className="mt-1.5 ml-4" onClick={onSelect}>
          {t('nodes.select')}
        </Button>
      )}
    </li>
  );
}
