/**
 * Teams 域入口：跨节点 Team 列表 + 既有群聊 / 成员详情。
 *
 * - 列表按节点独立成功 / 失败，一个节点 401 不吞掉其它节点；
 * - 搜索按 Team 名称 / id，节点过滤可从 `#/teams?node=` 深链进入；
 * - Create 弹窗写 canonical `teams.create`；Edit / Archive 在详情页。
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, SearchInput, Select } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { NodeTeams } from '../../gateway/team-roster';
import { t, useLocale } from '../../i18n';
import { teamListData, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { useNodeNames } from '../nodes/useNodeNames';
import { TeamDetailRoute } from './TeamDetailRoute';
import { TeamFormDialog } from './TeamFormDialog';
import { filterTeamResults } from './team-search';
import { teamNodeFilterFromHash } from './team-url';

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

export function TeamsView({ route, navigate }: TeamsViewProps) {
  useLocale();
  const { epoch, tenantEpoch, tenantId } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  const nodeNames = useNodeNames();
  const [query, setQuery] = useState('');
  const [nodeFilter, setNodeFilter] = useState(
    () => teamNodeFilterFromHash(window.location.hash) ?? '',
  );
  const [createOpen, setCreateOpen] = useState(false);
  const isDetail = 'teamId' in route;
  // 当前连接可以没有 token，但额外节点各自带凭据：任一节点可用即进入列表。
  const anyNodeToken = nodes.some((node) => hasTokenFor(node));
  const writableNodes = nodes.filter((node) => hasTokenFor(node));

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const lists = useTeamStore((state) => state.lists);
  const loadAllLists = useTeamStore((state) => state.loadAllLists);
  usePolledAction(
    () => {
      void loadAllLists(nodes, teamControl);
    },
    {
      enabled: anyNodeToken && nodes.length > 0 && !isDetail,
      pollMs: TEAMS_POLL_MS,
      deps: [epoch, tenantEpoch, nodeKeys],
    },
  );

  // `#/teams?node=` 深链来自 Node 详情的只读入口。
  useEffect(() => {
    const sync = () => setNodeFilter(teamNodeFilterFromHash(window.location.hash) ?? '');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const changeNodeFilter = (value: string) => {
    setNodeFilter(value);
    const next = value ? `#/teams?${new URLSearchParams({ node: value }).toString()}` : '#/teams';
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  };

  // Hooks 必须在任何早返回之前调用；列表数据在详情路由下未启用，这里只是空数组。
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

  if (!anyNodeToken) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  if ('teamId' in route) {
    const node = nodes.find((item) => nodeKeyOf(item) === route.nodeKey);
    if (!node) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
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
    return <TeamDetailRoute node={node} route={route} navigate={navigate} />;
  }

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
  if (!loaded) {
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
                    <li key={team.team_id}>
                      <button
                        type="button"
                        className="flex h-full w-full cursor-pointer flex-col gap-2 rounded-md border border-line bg-raised px-4 py-3 text-left text-ink transition-colors hover:border-line-strong hover:shadow-elev-1"
                        title={t('teams.card.open')}
                        onClick={() =>
                          navigate({
                            domain: 'teams',
                            nodeKey: nodeKeyOf(result.node),
                            teamId: team.team_id,
                          })
                        }
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={t('teams.title')} tenantId={tenantId} actions={createButton} />
      <div className="mt-5 flex flex-col gap-4">
        <div className="net-toolbar mt-3.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('team.list.search')}
            ariaLabel={t('team.list.search')}
            className="grow basis-60 max-w-search"
          />
          <Select
            className="net-select w-auto min-w-32 h-control py-0"
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
        {body}
      </div>

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
    </div>
  );
}
