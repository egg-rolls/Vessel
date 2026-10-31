/**
 * Teams 域的状态与副作用：列表轮询、搜索 / 节点过滤、详情路由、归档 / 冻结动作。
 *
 * 纯状态逻辑，不渲染；`TeamsView` 作为薄容器，把结果分发给同目录子视图。
 */
import { useEffect, useMemo, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { requestRefresh } from '../../app/refresh';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useViewportWidth } from '../../app/useViewportWidth';
import type { ActionMenuItem } from '../../components/ActionMenu';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { NodeTeams } from '../../gateway/team-roster';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { useAgentStore } from '../../stores/agentStore';
import { teamListData, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { useNodeNames } from '../nodes/useNodeNames';
import { filterTeamResults } from './team-search';
import { teamEditHash, teamNodeFilterFromHash } from './team-url';

const TEAMS_POLL_MS = 20_000;

/** 只有列表 hash 才同步 `?node=`；详情 / 编辑 hash 不重置当前过滤。 */
function isTeamsListHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path = ''] = raw.split('?', 2);
  const segments = path.split('/').filter(Boolean);
  return segments.length === 1 && segments[0] === 'teams';
}

export interface TeamsViewProps {
  route: Extract<Route, { domain: 'teams' }>;
  navigate: (route: Route) => void;
}

export function useTeamsView({ route, navigate }: TeamsViewProps) {
  useLocale();
  const toast = useToast();
  const { epoch, tenantEpoch } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  const nodeNames = useNodeNames();
  const compact = useViewportWidth() <= RAIL_MAX_WIDTH;
  const [query, setQuery] = useState('');
  const [nodeFilter, setNodeFilter] = useState(
    () => teamNodeFilterFromHash(window.location.hash) ?? '',
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{
    node: NodeView;
    team: TeamSummary;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [freezeBusy, setFreezeBusy] = useState<string | null>(null);
  const isDetail = 'teamId' in route;
  // 当前连接可以没有 token，但额外节点各自带凭据：任一节点可用即进入列表。
  const anyNodeToken = nodes.some((node) => hasTokenFor(node));
  const writableNodes = nodes.filter((node) => hasTokenFor(node));

  const drawerRef = useDrawerA11y({
    open: drawerOpen,
    onClose: () => setDrawerOpen(false),
    enabled: compact,
    returnFocusId: 'teams-list-toggle',
  });

  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact]);

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const lists = useTeamStore((state) => state.lists);
  const loadAllLists = useTeamStore((state) => state.loadAllLists);
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const archiveTeam = useTeamStore((state) => state.archive);
  const setSpawnFrozen = useTeamStore((state) => state.setSpawnFrozen);
  const loadRoster = useAgentStore((state) => state.loadRoster);

  // Team 栏常驻：详情路由下也继续轮询列表。
  usePolledAction(
    () => {
      void loadAllLists(nodes, teamControl);
    },
    {
      enabled: anyNodeToken && nodes.length > 0,
      pollMs: TEAMS_POLL_MS,
      deps: [epoch, tenantEpoch, nodeKeys],
    },
  );

  // `#/teams?node=` 深链来自 Node 详情的只读入口。
  useEffect(() => {
    const sync = () => {
      if (!isTeamsListHash(window.location.hash)) return;
      setNodeFilter(teamNodeFilterFromHash(window.location.hash) ?? '');
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const routeTeamKey = isDetail ? `${route.nodeKey}:${route.teamId}` : '';
  useEffect(() => {
    if (routeTeamKey) setDrawerOpen(false);
  }, [routeTeamKey]);

  const changeNodeFilter = (value: string) => {
    setNodeFilter(value);
    if (isDetail) return;
    const next = value ? `#/teams?${new URLSearchParams({ node: value }).toString()}` : '#/teams';
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  };

  // Hooks 必须在任何早返回之前调用。
  const data = useMemo(
    () =>
      nodes
        .map((node) => teamListData(lists[nodeKeyOf(node)]))
        .filter((result): result is NodeTeams => result !== undefined),
    [nodes, lists],
  );
  const loaded = nodes.length > 0 && data.length === nodes.length;
  const searched = useMemo(() => filterTeamResults(data, query), [data, query]);
  const visible = useMemo(
    () => (nodeFilter ? searched.filter((item) => nodeKeyOf(item.node) === nodeFilter) : searched),
    [searched, nodeFilter],
  );
  const allTeams = data.reduce((sum, item) => sum + item.teams.length, 0);
  const visibleTeams = visible.reduce((sum, item) => sum + item.teams.length, 0);
  const failed = data.filter((item) => !item.ok);
  const allFailed = data.length > 0 && failed.length === data.length;
  const partial = failed.length > 0 && failed.length < data.length;
  const hasSearchOrFilter = query.trim() !== '' || nodeFilter !== '';

  const nodeFor = (nodeKey: string) => nodes.find((node) => nodeKeyOf(node) === nodeKey);

  const reloadSummary = (node: NodeView, teamId: string) => {
    void loadDetail(
      nodeKeyOf(node),
      teamId,
      teamControl(node),
      { limit: 1, members_limit: 1 },
      'summary',
    );
  };

  const refreshCurrent = () => {
    void loadAllLists(nodes, teamControl);
    if (isDetail) {
      const node = nodeFor(route.nodeKey);
      if (node && hasTokenFor(node)) reloadSummary(node, route.teamId);
    }
    // 详情内容（TeamChat / MemberDetail）按各自的窗口大小重拉。
    requestRefresh();
  };

  const toggleFreeze = async (node: NodeView, team: TeamSummary) => {
    const key = `${nodeKeyOf(node)}:${team.team_id}`;
    if (freezeBusy !== null) return;
    const next = team.spawn_frozen !== true;
    setFreezeBusy(key);
    try {
      await setSpawnFrozen(teamControl(node), team.team_id, next);
      toast.success(next ? t('teams.frozen') : t('teams.unfrozen'));
      void loadAllLists(nodes, teamControl);
      reloadSummary(node, team.team_id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFreezeBusy(null);
    }
  };

  const confirmArchive = async () => {
    if (!archiveTarget || archiving) return;
    const { node, team } = archiveTarget;
    const nodeKey = nodeKeyOf(node);
    setArchiving(true);
    setArchiveError(null);
    try {
      const saved = await archiveTeam(teamControl(node), team.team_id);
      toast.success(`${saved.name || saved.team_id}: ${t('nodes.teams.archived')}`);
      setArchiveTarget(null);
      void loadAllLists(nodes, teamControl);
      void loadRoster(nodes, teamControl);
      if (isDetail && route.nodeKey === nodeKey && route.teamId === team.team_id) {
        navigate({ domain: 'teams' });
      } else {
        reloadSummary(node, team.team_id);
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiving(false);
    }
  };

  const openTeam = (node: NodeView, team: TeamSummary) => {
    navigate({
      domain: 'teams',
      nodeKey: nodeKeyOf(node),
      teamId: team.team_id,
    });
    if (compact) setDrawerOpen(false);
  };

  const menuItems = (node: NodeView, team: TeamSummary): ActionMenuItem[] => {
    const archived = team.archived_at !== undefined;
    const frozen = team.spawn_frozen === true;
    const canWrite = hasTokenFor(node) && !archived;
    return [
      {
        id: 'edit',
        label: t('common.edit'),
        disabled: !canWrite,
        onSelect: () => {
          window.location.hash = teamEditHash(nodeKeyOf(node), team.team_id);
          if (compact) setDrawerOpen(false);
        },
      },
      {
        id: 'freeze',
        label: frozen ? t('teams.unfreeze') : t('teams.freeze'),
        disabled: !canWrite || freezeBusy !== null,
        onSelect: () => {
          void toggleFreeze(node, team);
        },
      },
      {
        id: 'archive',
        label: t('common.archive'),
        danger: true,
        disabled: !canWrite,
        onSelect: () => {
          setArchiveError(null);
          setArchiveTarget({ node, team });
        },
      },
      {
        id: 'refresh',
        label: t('common.refresh'),
        onSelect: refreshCurrent,
      },
    ];
  };

  const clearSearch = () => {
    setQuery('');
    changeNodeFilter('');
  };

  const reloadLists = () => {
    void loadAllLists(nodes, teamControl);
  };

  const detailNode = isDetail ? nodeFor(route.nodeKey) : undefined;
  const detailRoute = isDetail ? route : undefined;

  return {
    navigate,
    isDetail,
    detailRoute,
    compact,
    drawerOpen,
    setDrawerOpen,
    drawerRef,
    query,
    setQuery,
    nodeFilter,
    changeNodeFilter,
    clearSearch,
    createOpen,
    setCreateOpen,
    archiveTarget,
    setArchiveTarget,
    archiving,
    archiveError,
    setArchiveError,
    nodes,
    writableNodes,
    nodeNames,
    anyNodeToken,
    loaded,
    data,
    visible,
    allFailed,
    allTeams,
    visibleTeams,
    partial,
    hasSearchOrFilter,
    refreshCurrent,
    openTeam,
    menuItems,
    confirmArchive,
    reloadLists,
    detailNode,
  };
}

export type TeamsViewState = ReturnType<typeof useTeamsView>;
