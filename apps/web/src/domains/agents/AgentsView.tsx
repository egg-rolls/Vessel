/**
 * Agents 域（0.24 Web IA）：跨节点 Team roster 的全局只读视图。
 *
 * - 数据只来自每节点的 `teams.list` + `teams.get`（经 `fetchNodeRoster`）；
 * - 过滤状态只存在 URL query 中，组件不另存副本；
 * - 节点级失败独立展示，不阻断其它节点。
 */
import { type ReactNode, useMemo } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import {
  agentFilterOptions,
  fetchNodeRoster,
  filterRosterAgents,
  flattenRoster,
  type NodeRoster,
} from '../../gateway/team-roster';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';

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

export function AgentsView({ route, navigate }: AgentsViewProps) {
  const { epoch, tenantEpoch, tenantId } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  // 额外节点各自带凭据；当前连接无 token 时不应屏蔽其它节点。
  const anyNodeToken = nodes.some((node) => hasTokenFor(node));

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const resource = useResource({
    load: () => Promise.all(nodes.map((node) => fetchNodeRoster(node, teamControl(node)))),
    enabled: anyNodeToken && nodes.length > 0,
    pollMs: ROSTER_POLL_MS,
    deps: [epoch, tenantEpoch, nodeKeys],
  });

  const loadedRosters = resourceData(resource.state);
  const loaded = loadedRosters !== undefined;
  const rosters = loadedRosters ?? [];
  const agents = useMemo(() => flattenRoster(rosters), [rosters]);
  const options = useMemo(() => agentFilterOptions(agents), [agents]);
  const filtered = useMemo(() => filterRosterAgents(agents, route), [agents, route]);
  const failed = rosters.filter((roster) => !roster.ok);
  const allFailed = rosters.length > 0 && failed.length === rosters.length;
  const partialErrors = rosters.reduce((sum, roster) => sum + roster.partialErrors, 0);
  const hasFilters = Boolean(route.nodeKey || route.teamId || route.state || route.presence);

  const header = (
    <PageHeader
      title={t('agents.title')}
      description={t('agents.description')}
      tenantId={tenantId}
    />
  );

  if (!anyNodeToken) {
    return (
      <div className="agents-view">
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="agents-view">
        {header}
        <EmptyState title={t('agents.empty')} description={t('agents.emptyHint')} />
      </div>
    );
  }

  let body: ReactNode;
  if (!loaded) {
    body = <LoadingState label={t('agents.loadingRosters')} rows={3} />;
  } else if (allFailed && rosters[0]?.code === 'not_found') {
    body = (
      <NotEnabledState
        title={t('teams.error.notEnabled')}
        reason={t('team.error.notEnabledReason')}
        hint={t('team.error.notEnabledHint')}
      />
    );
  } else if (allFailed) {
    // 全部节点失败：上面的节点级错误已给出原因，不再叠一个误导性的空态。
    body = null;
  } else if (agents.length === 0) {
    body = <EmptyState title={t('agents.empty')} description={t('agents.emptyHint')} />;
  } else if (filtered.length === 0) {
    body = (
      <EmptyState
        title={t('agents.empty')}
        description={t('agents.emptyHint')}
        action={
          <Button onClick={() => navigate({ domain: 'agents' })}>{t('agents.filter.clear')}</Button>
        }
      />
    );
  } else {
    body = (
      <div className="agents-table">
        <div className="agents-head" aria-hidden="true">
          <span>{t('agents.column.agent')}</span>
          <span>{t('agents.column.node')}</span>
          <span>{t('agents.column.team')}</span>
          <span>{t('agents.column.state')}</span>
          <span>{t('agents.column.presence')}</span>
        </div>
        <ul className="agents-list">
          {filtered.map((agent) => {
            const rowKey = `${nodeKeyOf(agent.node)}:${agent.team.team_id}:${agent.member.agent_id}`;
            const name = agent.member.name?.trim() || agent.member.agent_id;
            const presence =
              agent.member.presence === 'live'
                ? t('agents.presence.live')
                : t('agents.presence.gone');
            return (
              <li className="agents-item" key={rowKey}>
                <button
                  type="button"
                  className="agents-row"
                  title={t('agents.open')}
                  onClick={() =>
                    navigate({
                      domain: 'teams',
                      nodeKey: nodeKeyOf(agent.node),
                      teamId: agent.team.team_id,
                      agentId: agent.member.agent_id,
                    })
                  }
                >
                  <span className="agents-agent">{name}</span>
                  <span className="agents-node">{agent.node.name}</span>
                  <span className="agents-team">{agent.team.name || agent.team.team_id}</span>
                  <span className="agents-state">
                    <StatusChip status={agent.member.state} />
                  </span>
                  <span className={`agents-presence agents-presence-${agent.member.presence}`}>
                    <span className="agents-presence-dot" aria-hidden="true" />
                    {presence}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="agents-view">
      {header}
      <div className="agents-toolbar">
        <label className="agents-filter">
          <span>{t('agents.filter.node')}</span>
          <select
            className="input"
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
          </select>
        </label>
        <label className="agents-filter">
          <span>{t('agents.filter.team')}</span>
          <select
            className="input"
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
          </select>
        </label>
        <label className="agents-filter">
          <span>{t('agents.filter.state')}</span>
          <select
            className="input"
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
          </select>
        </label>
        <label className="agents-filter">
          <span>{t('agents.filter.presence')}</span>
          <select
            className="input"
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
          </select>
        </label>
        <span className="agents-count dim">
          {t('agents.count', { shown: filtered.length, total: agents.length })}
        </span>
        {hasFilters && filtered.length > 0 && (
          <Button size="small" onClick={() => navigate({ domain: 'agents' })}>
            {t('agents.filter.clear')}
          </Button>
        )}
      </div>

      {(failed.length > 0 || partialErrors > 0) && (
        <div className="agents-notices">
          {failed.map((roster) => (
            <p className="agents-node-error" role="alert" key={nodeKeyOf(roster.node)}>
              <span className="agents-node-error-name mono">{roster.node.name}</span>
              <span>{nodeErrorText(roster)}</span>
            </p>
          ))}
          {partialErrors > 0 && (
            <p className="agents-partial" role="status">
              {t('agents.partialErrors', { count: partialErrors })}
            </p>
          )}
        </div>
      )}

      {body}
    </div>
  );
}
