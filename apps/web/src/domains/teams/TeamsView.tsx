/**
 * Teams 域入口：跨节点 Team 栏 + 详情 pane。
 *
 * - Team 栏常驻：标题 / Create / 刷新、搜索、节点过滤、按节点分组的卡片；
 * - 每张卡片右侧的 ActionMenu 负责 Edit / Freeze / Archive / Refresh；
 * - 详情 pane 渲染 TeamDetailRoute；默认无 teamId 时显示“先打开 Team”空态，
 *   不自动打开第一个 Team；
 * - 窄屏下 Team 栏是抽屉（默认关闭），重开按钮在详情 / 空态处；
 * - 列表与详情状态来自 `teamStore`；归档 / 刷新后同步 roster。
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { requestRefresh } from '../../app/refresh';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useViewportWidth } from '../../app/useViewportWidth';
import { ActionMenu, type ActionMenuItem } from '../../components/ActionMenu';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, LoadingState, NotEnabledState } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, SearchInput, Select } from '../../components/ui';
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
import { TeamDetailRoute } from './TeamDetailRoute';
import { TeamFormDialog } from './TeamFormDialog';
import { filterTeamResults } from './team-search';
import { teamEditHash, teamNodeFilterFromHash } from './team-url';

export interface TeamsViewProps {
  route: Extract<Route, { domain: 'teams' }>;
  navigate: (route: Route) => void;
}

const TEAMS_POLL_MS = 20_000;

/** 节点级失败按稳定 code 映射；其它错误保留原始 message。 */
function nodeErrorText(result: NodeTeams): string {
  if (result.code === 'forbidden') return t('teams.error.forbidden');
  if (result.code === 'not_found') return t('teams.error.notEnabled');
  return result.error ?? t('common.loadFailed');
}

/** 只有列表 hash 才同步 `?node=`；详情 / 编辑 hash 不重置当前过滤。 */
function isTeamsListHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path = ''] = raw.split('?', 2);
  const segments = path.split('/').filter(Boolean);
  return segments.length === 1 && segments[0] === 'teams';
}

export function TeamsView({ route, navigate }: TeamsViewProps) {
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

  const createButton = (
    <Button
      variant="primary"
      onClick={() => setCreateOpen(true)}
      disabled={writableNodes.length === 0}
    >
      {t('nodes.teams.create')}
    </Button>
  );

  let body: ReactNode;
  if (!anyNodeToken) {
    body = (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  } else if (!loaded) {
    body = <LoadingState rows={3} />;
  } else if (allFailed && data[0]?.code === 'not_found') {
    body = (
      <NotEnabledState
        title={t('teams.error.notEnabled')}
        reason={t('team.error.notEnabledReason')}
        hint={t('team.error.notEnabledHint')}
      />
    );
  } else if (!allFailed && allTeams === 0) {
    body = (
      <EmptyState
        title={t('teams.empty')}
        action={writableNodes.length > 0 ? createButton : undefined}
      />
    );
  } else if (!allFailed && visibleTeams === 0 && hasSearchOrFilter) {
    body = (
      <EmptyState
        title={t('teams.empty')}
        action={<Button onClick={clearSearch}>{t('team.list.clearSearch')}</Button>}
      />
    );
  } else {
    body = (
      <>
        {partial && (
          <p
            className="m-0 rounded-sm border border-line-strong bg-warn-soft px-3 py-2 text-sm text-warn"
            role="status"
          >
            {t('teams.partialError')}
          </p>
        )}
        <div className="flex flex-col gap-5">
          {visible.map((result) => (
            <section
              className="flex min-w-0 flex-col gap-2"
              key={nodeKeyOf(result.node)}
              aria-label={nodeNames.get(nodeKeyOf(result.node)) ?? '—'}
            >
              <header className="flex items-center gap-2 border-b border-line pb-2">
                <span className="font-semibold text-ink">
                  {nodeNames.get(nodeKeyOf(result.node)) ?? '—'}
                </span>
                {result.node.current && (
                  <span className="whitespace-nowrap rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-ink">
                    {t('observe.attention.currentNode')}
                  </span>
                )}
              </header>
              {!result.ok ? (
                <p
                  className="m-0 rounded-sm border border-line-strong bg-danger-soft px-3 py-2 text-sm text-danger"
                  role="alert"
                >
                  {nodeErrorText(result)}
                </p>
              ) : result.teams.length === 0 ? (
                <p className="m-0 py-2 text-sm text-muted">{t('teams.empty')}</p>
              ) : (
                <ul className="teams-grid">
                  {result.teams.map((team) => (
                    <li className="teams-card" key={team.team_id}>
                      <button
                        type="button"
                        className="teams-card-open"
                        title={t('teams.card.open')}
                        onClick={() => openTeam(result.node, team)}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-semibold">
                            {team.name || team.team_id}
                          </span>
                          {team.archived_at !== undefined && (
                            <span className="whitespace-nowrap rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
                              {t('teams.card.archived')}
                            </span>
                          )}
                        </span>
                        <span className="wrap-anywhere font-mono text-xs text-faint">
                          {team.team_id}
                        </span>
                        <span className="flex flex-wrap gap-3 text-sm text-muted">
                          <span>{t('teams.card.members', { members: team.member_count })}</span>
                          <span>
                            {team.online_count !== undefined
                              ? t('teams.card.online', { online: team.online_count })
                              : '—'}
                          </span>
                        </span>
                        {team.description && (
                          <span className="line-clamp-2 text-sm text-muted">
                            {team.description}
                          </span>
                        )}
                      </button>
                      <ActionMenu
                        className="teams-card-menu"
                        label={`${t('common.moreActions')}: ${team.name || team.team_id}`}
                        items={menuItems(result.node, team)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </>
    );
  }

  let detail: ReactNode;
  if (!isDetail) {
    detail = (
      <div className="teams-detail-empty">
        <EmptyState
          title={t('teams.detail.emptyTitle')}
          description={t('teams.detail.emptyDesc')}
        />
      </div>
    );
  } else {
    const node = nodeFor(route.nodeKey);
    detail = node ? (
      <TeamDetailRoute node={node} route={route} navigate={navigate} />
    ) : (
      <div className="teams-detail-empty">
        <NotEnabledState
          title={t('teams.nodeMissing')}
          action={
            <Button onClick={() => navigate({ domain: 'teams' })}>
              {t('team.chat.backToList')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="teams-workspace">
      <aside
        {...(compact ? { role: 'dialog' as const, 'aria-modal': drawerOpen } : {})}
        ref={drawerRef}
        id="teams-column"
        className={`teams-column ${drawerOpen ? 'open' : ''}`.trim()}
        aria-label={t('teams.title')}
        inert={compact && !drawerOpen ? true : undefined}
        aria-hidden={compact && !drawerOpen ? true : undefined}
      >
        <header className="teams-column-head">
          <h2 className="teams-column-title">{t('teams.title')}</h2>
          <div className="teams-column-actions">
            {createButton}
            <Button size="small" onClick={refreshCurrent} disabled={!loaded}>
              {t('common.refresh')}
            </Button>
          </div>
        </header>
        <div className="teams-column-controls">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('team.list.search')}
            ariaLabel={t('team.list.search')}
          />
          <Select
            className="h-control w-full py-0"
            value={nodeFilter}
            onChange={(event) => changeNodeFilter(event.target.value)}
            aria-label={t('teams.filter.node')}
          >
            <option value="">{t('teams.filter.all')}</option>
            {nodes.map((node) => (
              <option key={nodeKeyOf(node)} value={nodeKeyOf(node)}>
                {nodeNames.get(nodeKeyOf(node)) ?? '—'}
              </option>
            ))}
          </Select>
        </div>
        <div className="teams-column-scroll">{body}</div>
      </aside>

      {compact && drawerOpen && (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label={t('common.close')}
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <section
        className="teams-detail-pane"
        aria-label={t('teams.title')}
        inert={compact && drawerOpen ? true : undefined}
      >
        <h1 className="sr-only">{t('teams.title')}</h1>
        {compact && (
          <div className="teams-detail-toolbar">
            <Button
              id="teams-list-toggle"
              size="small"
              aria-expanded={drawerOpen}
              aria-controls="teams-column"
              onClick={() => setDrawerOpen(true)}
            >
              {t('teams.openList')}
            </Button>
          </div>
        )}
        <div className="teams-detail-body">{detail}</div>
      </section>

      {createOpen && (
        <TeamFormDialog
          nodes={writableNodes}
          {...(nodeFilter ? { initialNodeKey: nodeFilter } : {})}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            void loadAllLists(nodes, teamControl);
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={t('nodes.teams.archiveTitle')}
          body={
            <>
              <p>{t('nodes.teams.archiveBody')}</p>
              <p className="font-mono">{archiveTarget.team.name || archiveTarget.team.team_id}</p>
              {archiveError && (
                <p className="text-xs text-danger leading-snug" role="alert">
                  {archiveError}
                </p>
              )}
            </>
          }
          confirmLabel={t('common.archive')}
          danger
          busy={archiving}
          onConfirm={() => {
            void confirmArchive();
          }}
          onCancel={() => {
            if (archiving) return;
            setArchiveTarget(null);
            setArchiveError(null);
          }}
        />
      )}
    </div>
  );
}
