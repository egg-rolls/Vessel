/**
 * Agents 域：跨节点 roster + 详情 / 编辑 / Create / Close。
 *
 * - 列表数据来自每节点的 `teams.list` + `teams.get`（经 `fetchNodeRoster`）；
 * - CRUD 走 canonical `agents.create|update|close`（单条批量形状，失败严格上报）；
 * - 详情 / 编辑是 `#/agents/<nodeKey>/<agentId>[/edit]`，查询串保留列表过滤；
 * - 名称优先，缺失回退短 id；原始 agent_id 只在 Advanced details 出现。
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { formatRoute, type Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button, SearchInput, Select } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import {
  agentFilterOptions,
  fetchNodeRoster,
  filterRosterAgents,
  flattenRoster,
  mergeNodeRosters,
  type NodeRoster,
  type RosterAgent,
} from '../../gateway/team-roster';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { useNodeNames } from '../nodes/useNodeNames';
import { AgentCreateDialog } from './AgentCreateDialog';
import { AgentDetailView } from './AgentDetailView';
import { AgentEditView } from './AgentEditView';
import { agentDisplayName, filterAgentsByQuery } from './agent-search';
import {
  type AgentHashTarget,
  agentDetailHash,
  agentEditHash,
  agentHashTarget,
  withQuery,
} from './agent-url';

export interface AgentsViewProps {
  route: Extract<Route, { domain: 'agents' }>;
  navigate: (route: Route) => void;
}

type AgentRoute = Extract<Route, { domain: 'agents' }>;
type FilterKey = 'nodeKey' | 'teamId' | 'state' | 'presence';

const ROSTER_POLL_MS = 20_000;
/** presence 是固定两层，不随 roster 变化。 */
const PRESENCE_OPTIONS = ['live', 'gone'] as const;

/** 节点级失败按稳定 code 映射；其它错误保留原始 message。 */
function nodeErrorText(roster: NodeRoster): string {
  if (roster.code === 'forbidden') return t('teams.error.forbidden');
  if (roster.code === 'not_found') return t('teams.error.notEnabled');
  return roster.error ?? t('common.loadFailed');
}

/** URL 是过滤的唯一事实源：空值 = 删除该键（“全部”）。 */
function withFilter(route: AgentRoute, key: FilterKey, value: string): AgentRoute {
  const next: AgentRoute = {
    domain: 'agents',
    ...(route.nodeKey ? { nodeKey: route.nodeKey } : {}),
    ...(route.teamId ? { teamId: route.teamId } : {}),
    ...(route.state ? { state: route.state } : {}),
    ...(route.presence ? { presence: route.presence } : {}),
  };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

/** 当前列表过滤的 query 串（不含 `?`），用于详情深链往返。 */
function filterQueryOf(route: AgentRoute): string {
  const [, query = ''] = formatRoute(route).split('?', 2);
  return query;
}

export function AgentsView({ route, navigate }: AgentsViewProps) {
  useLocale();
  const { epoch, tenantEpoch, tenantId } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  const nodeNames = useNodeNames();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<AgentHashTarget | undefined>(() =>
    agentHashTarget(window.location.hash),
  );
  // 额外节点各自带凭据；当前连接无 token 时不应屏蔽其它节点。
  const anyNodeToken = nodes.some((node) => hasTokenFor(node));
  const writableNodes = nodes.filter((node) => hasTokenFor(node));
  const filterQuery = filterQueryOf(route);

  useEffect(() => {
    const sync = () => setTarget(agentHashTarget(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const resource = useResource({
    load: () => Promise.all(nodes.map((node) => fetchNodeRoster(node, teamControl(node)))),
    enabled: anyNodeToken && nodes.length > 0,
    pollMs: ROSTER_POLL_MS,
    deps: [epoch, tenantEpoch, nodeKeys],
  });

  // 单节点失败时用上一轮成功数据兜底；否则轮询会把整页 roster 冲成空。
  const lastRosters = useRef<readonly NodeRoster[]>([]);
  const loadedRosters = resourceData(resource.state);
  const loaded = loadedRosters !== undefined;
  const rosters = useMemo(
    () => mergeNodeRosters(lastRosters.current, loadedRosters ?? []),
    [loadedRosters],
  );
  useEffect(() => {
    lastRosters.current = rosters;
  }, [rosters]);
  const rostersByNode = useMemo(
    () => new Map(rosters.map((roster) => [nodeKeyOf(roster.node), roster])),
    [rosters],
  );
  const agents = useMemo(() => flattenRoster(rosters), [rosters]);
  const options = useMemo(() => agentFilterOptions(agents), [agents]);
  const filtered = useMemo(
    () => filterAgentsByQuery(filterRosterAgents(agents, route), query),
    [agents, route, query],
  );
  const failed = rosters.filter((roster) => !roster.ok);
  const allFailed = rosters.length > 0 && failed.length === rosters.length;
  const partialErrors = rosters.reduce((sum, roster) => sum + roster.partialErrors, 0);
  const hasFilters = Boolean(
    route.nodeKey || route.teamId || route.state || route.presence || query.trim(),
  );

  // 归档 Team 只读，不能再绑定新 Agent。
  const teamsForNode = (nodeKey: string): readonly TeamSummary[] =>
    rostersByNode.get(nodeKey)?.teams.filter((team) => team.archived_at === undefined) ?? [];

  const openAgent = (nodeKey: string, agentId: string) => {
    window.location.hash = withQuery(agentDetailHash(nodeKey, agentId), filterQuery);
  };
  const openEdit = (nodeKey: string, agentId: string) => {
    window.location.hash = withQuery(agentEditHash(nodeKey, agentId), filterQuery);
  };
  const backToList = () => {
    window.location.hash = filterQuery ? `#/agents?${filterQuery}` : '#/agents';
  };

  const clearFilters = () => {
    setQuery('');
    navigate({ domain: 'agents' });
  };

  if (!anyNodeToken) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  // ── Agent 详情 / 编辑 ───────────────────────────────
  if (target) {
    const targetNode = nodes.find((node) => nodeKeyOf(node) === target.nodeKey);
    if (!targetNode) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
          <PageHeader title={t('agents.title')} tenantId={tenantId} />
          <div className="mt-5 flex flex-col gap-4">
            <NotEnabledState
              title={t('agents.error.nodeMissing')}
              action={<Button onClick={backToList}>{t('agents.back')}</Button>}
            />
          </div>
        </div>
      );
    }

    const roster = rostersByNode.get(target.nodeKey);
    const targetAgent: RosterAgent | undefined = roster
      ? flattenRoster([roster]).find((item) => item.member.agent_id === target.agentId)
      : undefined;

    if (!loaded) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
          <PageHeader title={t('agents.title')} tenantId={tenantId} />
          <div className="mt-5 flex flex-col gap-4">
            <LoadingState label={t('agents.loadingRosters')} rows={2} />
          </div>
        </div>
      );
    }

    if (!targetAgent) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
          <PageHeader title={t('agents.title')} tenantId={tenantId} />
          <div className="mt-5 flex flex-col gap-4">
            {roster && !roster.ok ? (
              <NotEnabledState title={t('teams.error.notEnabled')} reason={nodeErrorText(roster)} />
            ) : (
              <NotEnabledState
                title={t('agents.error.notFound')}
                action={<Button onClick={backToList}>{t('agents.back')}</Button>}
              />
            )}
          </div>
        </div>
      );
    }

    if (target.mode === 'edit') {
      return (
        <AgentEditView
          node={targetNode}
          agent={targetAgent}
          onBack={() => openAgent(target.nodeKey, target.agentId)}
          onSaved={() => resource.reload()}
        />
      );
    }

    return (
      <AgentDetailView
        node={targetNode}
        agent={targetAgent}
        onBack={backToList}
        onEdit={() => openEdit(target.nodeKey, target.agentId)}
        onSaved={() => resource.reload()}
        onOpenTeam={() =>
          navigate({
            domain: 'teams',
            nodeKey: target.nodeKey,
            teamId: targetAgent.team.team_id,
            agentId: target.agentId,
          })
        }
        onOpenSession={() => {
          const sessionId = targetAgent.member.session_id;
          if (sessionId) navigate({ domain: 'chat', sessionId });
        }}
      />
    );
  }

  // ── 列表 ────────────────────────────────────────────
  if (nodes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
        <PageHeader title={t('agents.title')} tenantId={tenantId} />
        <div className="mt-5 flex flex-col gap-4">
          <EmptyState title={t('agents.empty')} />
        </div>
      </div>
    );
  }

  let body: ReactNode;
  if (!loaded) {
    body = <LoadingState label={t('agents.loadingRosters')} rows={3} />;
  } else if (agents.length === 0 && allFailed && rosters[0]?.code === 'not_found') {
    body = (
      <NotEnabledState
        title={t('teams.error.notEnabled')}
        reason={t('team.error.notEnabledReason')}
        hint={t('team.error.notEnabledHint')}
      />
    );
  } else if (agents.length === 0 && allFailed) {
    body = null;
  } else if (agents.length === 0) {
    body = <EmptyState title={t('agents.empty')} />;
  } else if (filtered.length === 0) {
    body = (
      <EmptyState
        title={t('agents.empty')}
        action={<Button onClick={clearFilters}>{t('agents.filter.clear')}</Button>}
      />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {filtered.map((agent) => {
          const rowKey = `${nodeKeyOf(agent.node)}:${agent.team.team_id}:${agent.member.agent_id}`;
          const name = agentDisplayName(agent.member);
          const presence =
            agent.member.presence === 'live'
              ? t('agents.presence.live')
              : t('agents.presence.gone');
          return (
            <li
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-raised px-4 py-3"
              key={rowKey}
            >
              <div className="flex min-w-0 flex-1 basis-55 flex-col gap-0.5">
                <span className="inline-flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-md font-semibold text-ink">
                  {name}
                </span>
                <span className="min-w-0 wrap-anywhere text-xs text-faint">
                  {nodeNames.get(nodeKeyOf(agent.node)) ?? '—'} ·{' '}
                  {agent.team.name || agent.team.team_id}
                </span>
              </div>
              <StatusChip status={agent.member.state} />
              <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap text-sm text-muted">
                <span
                  className={`size-1.75 rounded-full ${
                    agent.member.presence === 'live' ? 'bg-success' : 'bg-faint'
                  }`}
                  aria-hidden="true"
                />
                {presence}
              </span>
              <div className="ml-auto inline-flex flex-none flex-wrap items-center gap-2">
                <Button
                  size="small"
                  onClick={() => openAgent(nodeKeyOf(agent.node), agent.member.agent_id)}
                >
                  {t('agents.open')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader
        title={t('agents.title')}
        tenantId={tenantId}
        actions={
          <Button
            variant="primary"
            disabled={writableNodes.length === 0}
            onClick={() => setCreateOpen(true)}
          >
            {t('agents.create')}
          </Button>
        }
      />
      <div className="mt-5 flex flex-col gap-4">
        <div className="net-toolbar mt-3.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('agents.search')}
            ariaLabel={t('agents.search')}
            className="grow basis-60 max-w-search"
          />
          <Select
            className="net-select w-auto min-w-32 h-control py-0"
            value={route.nodeKey ?? ''}
            aria-label={t('agents.filter.node')}
            onChange={(event) => navigate(withFilter(route, 'nodeKey', event.target.value))}
          >
            <option value="">{t('agents.filter.all')}</option>
            {options.nodes.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            className="net-select w-auto min-w-32 h-control py-0"
            value={route.teamId ?? ''}
            aria-label={t('agents.filter.team')}
            onChange={(event) => navigate(withFilter(route, 'teamId', event.target.value))}
          >
            <option value="">{t('agents.filter.all')}</option>
            {options.teams.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            className="net-select w-auto min-w-32 h-control py-0"
            value={route.state ?? ''}
            aria-label={t('agents.filter.state')}
            onChange={(event) => navigate(withFilter(route, 'state', event.target.value))}
          >
            <option value="">{t('agents.filter.all')}</option>
            {options.states.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </Select>
          <Select
            className="net-select w-auto min-w-32 h-control py-0"
            value={route.presence ?? ''}
            aria-label={t('agents.filter.presence')}
            onChange={(event) => navigate(withFilter(route, 'presence', event.target.value))}
          >
            <option value="">{t('agents.filter.all')}</option>
            {PRESENCE_OPTIONS.map((presence) => (
              <option key={presence} value={presence}>
                {t(`agents.presence.${presence}`)}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-sm tabular-nums text-muted">
            {t('agents.count', { shown: filtered.length, total: agents.length })}
          </span>
          {hasFilters && (
            <Button size="small" onClick={clearFilters}>
              {t('agents.filter.clear')}
            </Button>
          )}
        </div>

        {(failed.length > 0 || partialErrors > 0) && (
          <div className="flex flex-col gap-2">
            {failed.map((roster) => (
              <p
                className="m-0 flex flex-wrap gap-2 rounded-sm border border-line-strong bg-danger-soft px-3 py-2 text-sm text-danger"
                role="alert"
                key={nodeKeyOf(roster.node)}
              >
                <span className="flex-none font-semibold">
                  {nodeNames.get(nodeKeyOf(roster.node)) ?? '—'}
                </span>
                <span>{nodeErrorText(roster)}</span>
                {roster.stale && (
                  <span className="flex-none text-faint">{t('agents.staleNode')}</span>
                )}
              </p>
            ))}
            {partialErrors > 0 && (
              <p
                className="m-0 rounded-sm border border-line-strong bg-warn-soft px-3 py-2 text-sm text-warn"
                role="status"
              >
                {t('agents.partialErrors', { count: partialErrors })}
              </p>
            )}
          </div>
        )}

        {body}
      </div>

      {createOpen && (
        <AgentCreateDialog
          nodes={writableNodes}
          teamsForNode={teamsForNode}
          {...(route.nodeKey ? { initialNodeKey: route.nodeKey } : {})}
          onClose={() => setCreateOpen(false)}
          onSaved={() => resource.reload()}
        />
      )}
    </div>
  );
}
