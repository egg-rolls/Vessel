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
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, SearchInput } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { fetchAllNodeTeams, type NodeTeams } from '../../gateway/team-roster';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
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
  const resource = useResource({
    load: () => fetchAllNodeTeams(nodes, teamControl),
    enabled: anyNodeToken && nodes.length > 0 && !isDetail,
    pollMs: TEAMS_POLL_MS,
    deps: [epoch, tenantEpoch, nodeKeys],
  });

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
  const results = resourceData(resource.state);
  const loaded = results !== undefined;
  const data = results ?? [];
  const loadedError =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : undefined;
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
      <div className="domain-view">
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  if ('teamId' in route) {
    const node = nodes.find((item) => nodeKeyOf(item) === route.nodeKey);
    if (!node) {
      return (
        <div className="domain-view">
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
    body = loadedError ? (
      <ErrorState message={loadedError.message} onRetry={resource.reload} />
    ) : (
      <LoadingState rows={3} />
    );
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
          <p className="teams-partial" role="status">
            {t('teams.partialError')}
          </p>
        )}
        <div className="teams-nodes">
          {visible.map((result) => (
            <section
              className="teams-node-group"
              key={nodeKeyOf(result.node)}
              aria-label={nodeNames.get(nodeKeyOf(result.node)) ?? '—'}
            >
              <header className="teams-node-head">
                <span className="teams-node-name">
                  {nodeNames.get(nodeKeyOf(result.node)) ?? '—'}
                </span>
                {result.node.current && (
                  <span className="teams-node-current">{t('observe.attention.currentNode')}</span>
                )}
              </header>
              {!result.ok ? (
                <p className="teams-node-error" role="alert">
                  {nodeErrorText(result)}
                </p>
              ) : result.teams.length === 0 ? (
                <p className="teams-node-empty dim">{t('teams.empty')}</p>
              ) : (
                <ul className="teams-grid">
                  {result.teams.map((team) => (
                    <li key={team.team_id}>
                      <button
                        type="button"
                        className="net-card teams-card"
                        title={t('teams.card.open')}
                        onClick={() =>
                          navigate({
                            domain: 'teams',
                            nodeKey: nodeKeyOf(result.node),
                            teamId: team.team_id,
                          })
                        }
                      >
                        <span className="teams-card-head">
                          <span className="teams-card-name">{team.name || team.team_id}</span>
                          {team.archived_at !== undefined && (
                            <span className="teams-card-archived">{t('teams.card.archived')}</span>
                          )}
                        </span>
                        <span className="net-row-sub mono">{team.team_id}</span>
                        <span className="teams-card-meta">
                          <span>{t('teams.card.members', { members: team.member_count })}</span>
                          <span>
                            {team.online_count !== undefined
                              ? t('teams.card.online', { online: team.online_count })
                              : '—'}
                          </span>
                        </span>
                        {team.description && (
                          <span className="teams-card-desc">{team.description}</span>
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
    <div className="domain-view">
      <PageHeader title={t('teams.title')} tenantId={tenantId} actions={createButton} />
      <div className="domain-content">
        <div className="filter-bar net-toolbar">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('team.list.search')}
            ariaLabel={t('team.list.search')}
          />
          <select
            className="input net-select"
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
          </select>
        </div>
        {body}
      </div>

      {createOpen && (
        <TeamFormDialog
          nodes={writableNodes}
          {...(nodeFilter ? { initialNodeKey: nodeFilter } : {})}
          onClose={() => setCreateOpen(false)}
          onSaved={() => resource.reload()}
        />
      )}
    </div>
  );
}
