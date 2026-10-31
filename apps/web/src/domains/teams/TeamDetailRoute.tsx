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
import { agentBodyHash, agentDetailHash } from '../agents/agent-url';
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

  // 成员面板已收敛到 Agents 域：旧 `#/teams/.../agents/<id>` 深链重定向过去。
  useEffect(() => {
    if (!route.agentId) return;
    const hash = route.bodyId
      ? agentBodyHash(nodeKey, route.agentId, route.bodyId)
      : agentDetailHash(nodeKey, route.agentId);
    if (window.location.hash === hash) return;
    // replaceState 不产生历史记录，也不会自己触发 hashchange；显式通知壳层重解析。
    // 延后到微任务，等父级 useHashRoute 的监听注册完成。
    window.history.replaceState(null, '', hash);
    queueMicrotask(() => window.dispatchEvent(new Event('hashchange')));
  }, [route.agentId, route.bodyId, nodeKey]);

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

  // 重定向进行中：不渲染群聊，避免旧成员深链闪一帧。
  if (route.agentId) return null;

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
        onOpenMember={(agentId) => {
          // 成员面板只在 Agents 域渲染；这里直接切到同一条 agents 深链。
          window.location.hash = agentDetailHash(nodeKey, agentId);
        }}
        onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
        onBackToList={() => navigate({ domain: 'teams' })}
      />
    </div>
  );
}
