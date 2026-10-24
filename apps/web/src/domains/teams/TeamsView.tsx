/**
 * Teams 域入口（0.24 Web IA）：跨节点 Team 列表 + 既有群聊 / 成员详情。
 *
 * - 列表按节点独立成功 / 失败，一个节点 401 不吞掉其它节点；
 * - 详情复用 `TeamChat` / `MemberDetail`，只为额外节点注入各自的控制面；
 * - 列表轮询 20s；路由是详情的唯一事实源，不在本地复制选中状态。
 */
import { type ReactNode, useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button } from '../../components/ui';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { fetchAllNodeTeams, type NodeTeams } from '../../gateway/team-roster';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { MemberDetail } from '../team/MemberDetail';
import { TeamChat } from '../team/TeamChat';

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

function NodeBadge({ node }: { node: NodeView }) {
  return (
    <div className="teams-detail-node">
      <span className="teams-node-badge">{node.name}</span>
      {node.current && (
        <span className="teams-node-current">{t('observe.attention.currentNode')}</span>
      )}
      <span className="teams-node-key mono">{nodeKeyOf(node)}</span>
    </div>
  );
}

export function TeamsView({ route, navigate }: TeamsViewProps) {
  const { connectionState, epoch, tenantEpoch, tenantId, permissions, asks } = useConnection();
  const { nodes, teamControl, hasTokenFor } = useNodes();
  const snapshot = useEventSnapshot();
  const [nodeFilter, setNodeFilter] = useState('');
  const isDetail = 'teamId' in route;
  // 当前连接可以没有 token，但额外节点各自带凭据：任一节点可用即进入列表。
  const anyNodeToken = nodes.some((node) => hasTokenFor(node));

  const nodeKeys = nodes.map((node) => nodeKeyOf(node)).join(',');
  const resource = useResource({
    load: () => fetchAllNodeTeams(nodes, teamControl),
    enabled: anyNodeToken && nodes.length > 0 && !isDetail,
    pollMs: TEAMS_POLL_MS,
    deps: [epoch, tenantEpoch, nodeKeys],
  });

  const results = resourceData(resource.state);
  const loaded = results !== undefined;
  const data = results ?? [];
  const loadedError =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : undefined;

  const visible = useMemo(
    () => (nodeFilter ? data.filter((item) => nodeKeyOf(item.node) === nodeFilter) : data),
    [data, nodeFilter],
  );
  const allTeams = data.reduce((sum, item) => sum + item.teams.length, 0);
  const visibleTeams = visible.reduce((sum, item) => sum + item.teams.length, 0);
  const failed = data.filter((item) => !item.ok);
  const allFailed = data.length > 0 && failed.length === data.length;
  const partial = failed.length > 0 && failed.length < data.length;

  if (!anyNodeToken) {
    return (
      <div className="teams-view">
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  if ('teamId' in route) {
    const node = nodes.find((item) => nodeKeyOf(item) === route.nodeKey);
    if (!node) {
      return (
        <div className="teams-view">
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

    const control = teamControl(node);
    const token = hasTokenFor(node);
    const currentEvents = node.current ? snapshot.entries : [];
    const currentPermissions = node.current ? permissions : [];
    const currentAsks = node.current ? asks : [];

    if (route.agentId) {
      return (
        <div className="teams-view teams-detail">
          <div className="teams-detail-head">
            <NodeBadge node={node} />
          </div>
          <MemberDetail
            client={control}
            hasToken={token}
            epoch={epoch}
            tenantEpoch={tenantEpoch}
            teamId={route.teamId}
            memberId={route.agentId}
            {...(route.bodyId ? { bodyId: route.bodyId } : {})}
            events={currentEvents}
            onBack={() =>
              navigate({ domain: 'teams', nodeKey: route.nodeKey, teamId: route.teamId })
            }
            onBackToMember={() =>
              navigate({
                domain: 'teams',
                nodeKey: route.nodeKey,
                teamId: route.teamId,
                agentId: route.agentId,
              })
            }
            onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
            onOpenBody={(sessionId) =>
              navigate({
                domain: 'teams',
                nodeKey: route.nodeKey,
                teamId: route.teamId,
                agentId: route.agentId,
                bodyId: sessionId,
              })
            }
          />
        </div>
      );
    }

    return (
      <div className="teams-view teams-detail">
        <div className="teams-detail-head">
          <NodeBadge node={node} />
        </div>
        <TeamChat
          key={route.teamId}
          client={control}
          hasToken={token}
          connectionState={node.current ? connectionState : 'open'}
          epoch={epoch}
          tenantEpoch={tenantEpoch}
          teamId={route.teamId}
          permissions={currentPermissions}
          asks={currentAsks}
          events={currentEvents}
          onOpenMember={(agentId) =>
            navigate({
              domain: 'teams',
              nodeKey: route.nodeKey,
              teamId: route.teamId,
              agentId,
            })
          }
          onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
          onBackToList={() => navigate({ domain: 'teams' })}
        />
      </div>
    );
  }

  const header = (
    <PageHeader title={t('teams.title')} description={t('teams.description')} tenantId={tenantId} />
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
    body = <EmptyState title={t('teams.empty')} description={t('teams.emptyHint')} />;
  } else if (!allFailed && visibleTeams === 0) {
    body = (
      <EmptyState
        title={t('teams.empty')}
        description={t('teams.emptyHint')}
        action={<Button onClick={() => setNodeFilter('')}>{t('agents.filter.clear')}</Button>}
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
              aria-label={result.node.name}
            >
              <header className="teams-node-head">
                <span className="teams-node-name">{result.node.name}</span>
                {result.node.current && (
                  <span className="teams-node-current">{t('observe.attention.currentNode')}</span>
                )}
                <span className="teams-node-key mono">{nodeKeyOf(result.node)}</span>
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
                        className="teams-card"
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
                        <span className="teams-card-id mono">{team.team_id}</span>
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
                        <span className="teams-card-principal">
                          {t('teams.card.principal', {
                            principal: team.default_principal || '—',
                          })}
                        </span>
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
    <div className="teams-view">
      {header}
      <div className="teams-toolbar">
        <label className="teams-filter">
          <span>{t('teams.filter.node')}</span>
          <select
            className="input"
            value={nodeFilter}
            onChange={(event) => setNodeFilter(event.target.value)}
            aria-label={t('teams.filter.node')}
          >
            <option value="">{t('teams.filter.all')}</option>
            {nodes.map((node) => (
              <option key={nodeKeyOf(node)} value={nodeKeyOf(node)}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {body}
    </div>
  );
}
