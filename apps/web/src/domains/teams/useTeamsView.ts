/**
 * Teams 域的状态与副作用：列表轮询、搜索 / 节点过滤、详情路由、归档 / 冻结动作。
 *
 * 纯状态逻辑，不渲染；`TeamsView` 作为薄容器，把结果分发给同目录子视图。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { requestRefresh } from '../../app/refresh';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useViewportWidth } from '../../app/useViewportWidth';
import type { ActionMenuItem } from '../../components/ActionMenu';
import { useToast } from '../../components/ToastProvider';
import { copyText } from '../../components/ui/clipboard';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { NodeTeams } from '../../gateway/team-roster';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import {
  filterArchivedTeams,
  hiddenPendingRemovalCount,
  isArchivedTeam,
} from '../../state/archive-visibility';
import { useShowArchived } from '../../state/useShowArchived';
import { useAgentStore } from '../../stores/agentStore';
import { teamDetailKey, teamListData, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { useNodeNames } from '../nodes/useNodeNames';
import {
  browserSessionStorage,
  clearLastTeam,
  decideTeamRestore,
  readLastTeam,
  readLastTeamRecord,
  teamRecordKey,
  writeLastTeam,
} from '../team/team-selection';
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
  const { epoch } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  const nodeNames = useNodeNames();
  const compact = useViewportWidth() <= RAIL_MAX_WIDTH;
  const [query, setQuery] = useState('');
  const [nodeFilter, setNodeFilter] = useState(
    () => teamNodeFilterFromHash(window.location.hash) ?? '',
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * 成员栏开关（单一 boolean）：入口在 Team 卡 ActionMenu。
   * 切 Team 不强制关闭——用户打开了成员栏，换 Team 时保持展开，直到再次点「收起」。
   */
  const [membersOpen, setMembersOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{
    node: NodeView;
    team: TeamSummary;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [freezeBusy, setFreezeBusy] = useState<string | null>(null);
  /**
   * 「上次打开的 Team」还在判（列表未到）：详情 pane 先别显示「先打开 Team」空态，
   * 免得恢复跟上后闪一句假话。判完（restore / 清记录）立刻落地。
   */
  const [restorePending, setRestorePending] = useState(false);
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
      deps: [epoch, nodeKeys],
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

  /** 当前详情路由的 node / team（列表页为空串）：写入与清除记录都按这一对判断。 */
  const detailNodeKey = isDetail ? route.nodeKey : '';
  const detailTeamId = isDetail ? route.teamId : '';

  // 选中即写：列表点击 / 深链进入 / 自动恢复最后都落到同一个详情路由，只在这一处写。
  useEffect(() => {
    if (!detailTeamId) return;
    writeLastTeam(browserSessionStorage(), detailNodeKey, detailTeamId);
  }, [detailNodeKey, detailTeamId]);

  /**
   * 团队被删（`teams.get` 返回 `not_found`）：只清记录，不改变当前错误页 ——
   * 与会话页的 NOT_FOUND 处理同口径，避免下次进入继续恢复一个不存在的 Team。
   */
  const summaryKey = detailTeamId ? teamDetailKey(detailNodeKey, detailTeamId, 'summary') : '';
  const detailSummary = useTeamStore((state) =>
    summaryKey ? state.details[summaryKey] : undefined,
  );
  const detailSummaryCode = detailSummary?.status === 'error' ? detailSummary.code : undefined;
  useEffect(() => {
    if (!detailTeamId || detailSummaryCode !== 'not_found') return;
    const storage = browserSessionStorage();
    // 记录指向的正是这个已消失的 Team：清掉，别让下次进入继续恢复它。
    if (readLastTeam(storage, detailNodeKey) === detailTeamId) {
      clearLastTeam(storage, detailNodeKey);
    }
  }, [detailNodeKey, detailTeamId, detailSummaryCode]);

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

  /**
   * 已归档 Team 默认不出现在列表里（0.51）：只在这里裁一次，搜索 / 节点过滤都基于
   * 裁过的 `visibleData`，所以「默认搜索搜不到归档对象」是同一个开关的自然结果，
   * 打开开关后它们又回到可搜集合。
   *
   * 为什么不在 detail 层裁：直接 URL / 收藏链接必须仍能打开归档 Team（详情页给
   * 待移除提示），隐藏只发生在「列表 + 搜索」这条展示路径上。
   */
  const showArchived = useShowArchived();
  const visibleData = useMemo(
    () =>
      data.map((item) =>
        item.ok ? { ...item, teams: filterArchivedTeams(item.teams, showArchived) } : item,
      ),
    [data, showArchived],
  );
  /**
   * 被开关挡掉的归档 Team 数（开关打开时恒 0）：提示语与「全都归档了」空态都读它，
   * 否则打开开关后界面会一边列出卡片、一边宣称「已隐藏 N 个」。
   */
  const hiddenArchivedTeams = useMemo(
    () =>
      hiddenPendingRemovalCount(
        data.flatMap((item) => (item.ok ? item.teams : [])),
        showArchived,
        isArchivedTeam,
      ),
    [data, showArchived],
  );

  /**
   * 已加载 Team 的身份集合（`nodeKey:teamId`）；null = 还不能判断记录是否失效
   * （列表还没到，或有节点拉列表失败）：这时**绝不**清记录，等下一次进入重试。
   */
  const knownTeamKeys = useMemo<readonly string[] | null>(() => {
    if (nodes.length === 0 || data.length !== nodes.length) return null;
    if (data.some((item) => !item.ok)) return null;
    return data.flatMap((item) =>
      item.teams.map((team) => teamRecordKey(nodeKeyOf(item.node), team.team_id)),
    );
  }, [nodes, data]);

  /**
   * 恢复「上次打开的 Team」（口径照抄会话页 `decideSessionRestore`）：
   * - 只在进入 Teams 域的那次挂载里判一次：之后用户点「返回列表」不会再被拽回详情，
   *   重新进入 Teams 域 / 刷新才会恢复；
   * - 路由已有 `teamId` 时一律 keep —— **URL 权威**，恢复只补默认值，不覆盖 URL；
   * - 记录仍在已加载列表里 → 补上那个默认值；失效（被删 / 归档 / 无权限 / 不在
   *   roster）→ 清记录并停在列表页（Team 页的默认态）；
   * - 记录没就绪（列表未到 / 有节点失败）→ 不判失效，保留记录。
   */
  const restoreDecided = useRef(false);
  useEffect(() => {
    if (restoreDecided.current) return;
    // `#/teams?node=<nodeKey>` 是「看这个节点的团队列表」的深链：URL 已表达意图，
    // 恢复只补「什么选择都没有」的默认值，这里不插手（记录留着下次再试）。
    if (teamNodeFilterFromHash(window.location.hash)) return;
    const storage = browserSessionStorage();
    const record = detailTeamId ? null : readLastTeamRecord(storage);
    const decision = decideTeamRestore({
      ...(detailTeamId ? { routeTeamId: detailTeamId } : {}),
      stored: record,
      knownTeams: detailTeamId ? null : knownTeamKeys,
    });
    if (decision.kind === 'wait') {
      // 列表还在路上：详情 pane 先保持「恢复中」，不显示误导的空态。
      setRestorePending(record !== null && data.length < nodes.length);
      return;
    }
    restoreDecided.current = true;
    setRestorePending(false);
    if (decision.kind === 'restore') {
      navigate({ domain: 'teams', nodeKey: decision.nodeKey, teamId: decision.teamId });
      return;
    }
    if (decision.kind === 'default' && decision.clear && record) {
      clearLastTeam(storage, record.nodeKey);
    }
  }, [data.length, detailTeamId, knownTeamKeys, navigate, nodes.length]);

  const searched = useMemo(() => filterTeamResults(visibleData, query), [visibleData, query]);
  const visible = useMemo(
    () => (nodeFilter ? searched.filter((item) => nodeKeyOf(item.node) === nodeFilter) : searched),
    [searched, nodeFilter],
  );
  // 计数口径统一用「过掉开关之后的列表」：卡片数与「已隐藏 N 个」提示因此不会互相打架。
  const allTeams = visibleData.reduce((sum, item) => sum + item.teams.length, 0);
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
      // 归档即下线：记录若指向它就不能再被恢复（与会话被删后清记录同口径）。
      const storage = browserSessionStorage();
      if (readLastTeam(storage, nodeKey) === team.team_id) {
        clearLastTeam(storage, nodeKey);
      }
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

  /**
   * 卡片是否选中：当前详情路由的 `nodeKey + teamId` 与卡片自身一致。
   * 列表卡片高亮、成员栏 ActionMenu 标签、成员栏开关都复用它，不新造状态；
   * 没有详情路由（列表页）时恒为 false。
   */
  const isActiveTeam = (node: NodeView, team: TeamSummary) =>
    isDetail && route.nodeKey === nodeKeyOf(node) && route.teamId === team.team_id;

  /**
   * 成员栏开关语义：对**当前打开的 Team** 点 = 切换开关；对**别的 Team** 点 =
   * 先 `openTeam`（窄屏顺手收起左栏抽屉）再把成员栏打开。
   */
  const toggleMembers = (node: NodeView, team: TeamSummary) => {
    if (isActiveTeam(node, team)) {
      setMembersOpen((open) => !open);
      return;
    }
    openTeam(node, team);
    setMembersOpen(true);
  };

  const menuItems = (node: NodeView, team: TeamSummary): ActionMenuItem[] => {
    const archived = team.archived_at !== undefined;
    const frozen = team.spawn_frozen === true;
    const canWrite = hasTokenFor(node) && !archived;
    const membersShown = isActiveTeam(node, team) && membersOpen;
    return [
      {
        // 编辑整页是这张卡片的主要入口（信息查看 + 修改），排第一；打开成员栏次之。
        id: 'edit',
        label: t('common.edit'),
        disabled: !canWrite,
        onSelect: () => {
          window.location.hash = teamEditHash(nodeKeyOf(node), team.team_id);
          if (compact) setDrawerOpen(false);
        },
      },
      {
        // 打开 / 收起右侧成员栏（原页头「查看成员列表」按钮的入口）。
        id: 'members',
        label: membersShown ? t('team.members.close') : t('team.members.open'),
        disabled: !hasTokenFor(node),
        onSelect: () => {
          toggleMembers(node, team);
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
      {
        // 卡片不再常显 team_id（DESIGN-0.33.0 §4 step 3）：id 属 Detail 槽，按需复制即可。
        id: 'copyId',
        label: t('teams.card.copyId'),
        onSelect: () => {
          void copyText(team.team_id)
            .then(() => toast.success(t('common.copied')))
            .catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error));
            });
        },
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
    restorePending,
    detailRoute,
    compact,
    drawerOpen,
    setDrawerOpen,
    drawerRef,
    membersOpen,
    setMembersOpen,
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
    hiddenArchivedTeams,
    showArchived,
    partial,
    hasSearchOrFilter,
    refreshCurrent,
    openTeam,
    isActiveTeam,
    menuItems,
    confirmArchive,
    reloadLists,
    detailNode,
  };
}

export type TeamsViewState = ReturnType<typeof useTeamsView>;
