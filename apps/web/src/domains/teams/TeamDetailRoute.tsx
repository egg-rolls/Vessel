/**
 * Team 详情路由：群聊 / 成员详情。
 *
 * Edit / Freeze / Archive 已移到 Team 栏卡片的 ActionMenu；这里只保留
 * 节点 badge、冻结 badge 与 TeamChat / MemberDetail。
 * 归档 Team 只读：TeamChat 自己禁用发送。
 */
import { useEffect, useState } from 'react';
import { formatRoute, type Route } from '../../app/router';
import { Badge } from '../../components/ui';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { resourceData } from '../../state/useResource';
import { teamDetailKey, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { MemberDetail } from '../team/MemberDetail';
import { TeamChat } from '../team/TeamChat';
import { TeamEditView } from './TeamEditView';
import { TeamNodeBadge } from './TeamNodeBadge';
import { isTeamEditHash } from './team-url';

type TeamsDetailRoute = Extract<Route, { domain: 'teams'; teamId: string }>;

export function TeamDetailRoute({
  node,
  route,
  navigate,
}: {
  node: NodeView;
  route: TeamsDetailRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const {
    connectionState,
    epoch,
    tenantEpoch,
    permissions,
    asks,
    responding,
    respondPermission,
    respondAsk,
  } = useConnection();
  const { teamControl, hasTokenFor } = useNodes();
  const snapshot = useEventSnapshot();
  const control = teamControl(node);
  const hasToken = hasTokenFor(node);
  const [editing, setEditing] = useState(() =>
    isTeamEditHash(window.location.hash, route.nodeKey, route.teamId),
  );

  const nodeKey = nodeKeyOf(node);
  const summaryState = useTeamStore(
    (state) => state.details[teamDetailKey(nodeKey, route.teamId, 'summary')],
  );
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const reloadSummary = () => {
    void loadDetail(nodeKey, route.teamId, control, { limit: 1, members_limit: 1 }, 'summary');
  };
  usePolledAction(
    () => {
      void loadDetail(nodeKey, route.teamId, control, { limit: 1, members_limit: 1 }, 'summary');
    },
    { enabled: hasToken, deps: [epoch, tenantEpoch, nodeKey, route.teamId] },
  );
  const summary = resourceData(summaryState)?.team;

  useEffect(() => {
    const sync = () =>
      setEditing(isTeamEditHash(window.location.hash, route.nodeKey, route.teamId));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [route.nodeKey, route.teamId]);

  const backToDetail = () => {
    window.location.hash = formatRoute({
      domain: 'teams',
      nodeKey: route.nodeKey,
      teamId: route.teamId,
    });
  };

  if (editing) {
    return (
      <TeamEditView
        node={node}
        teamId={route.teamId}
        onBack={backToDetail}
        onSaved={reloadSummary}
      />
    );
  }

  const currentEvents = node.current ? snapshot.entries : [];
  const currentPermissions = node.current ? permissions : [];
  const currentAsks = node.current ? asks : [];

  if (route.agentId) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="teams-detail-head">
          <TeamNodeBadge node={node} />
        </div>
        <MemberDetail
          client={control}
          hasToken={hasToken}
          epoch={epoch}
          tenantEpoch={tenantEpoch}
          teamId={route.teamId}
          memberId={route.agentId}
          nodeKey={nodeKey}
          {...(route.bodyId ? { bodyId: route.bodyId } : {})}
          events={currentEvents}
          onBack={() => navigate({ domain: 'teams', nodeKey: route.nodeKey, teamId: route.teamId })}
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="teams-detail-head">
        <TeamNodeBadge node={node} />
        {summary?.spawn_frozen === true && <Badge tone="warn">{t('teams.frozen')}</Badge>}
      </div>
      <TeamChat
        key={route.teamId}
        client={control}
        hasToken={hasToken}
        connectionState={node.current ? connectionState : 'open'}
        epoch={epoch}
        tenantEpoch={tenantEpoch}
        teamId={route.teamId}
        nodeKey={nodeKey}
        permissions={currentPermissions}
        asks={currentAsks}
        events={currentEvents}
        responding={responding}
        onDecidePermission={(requestId, decision, scope) => {
          void respondPermission(requestId, decision, scope);
        }}
        onRespondAsk={(requestId, answers) => {
          void respondAsk(requestId, answers);
        }}
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
