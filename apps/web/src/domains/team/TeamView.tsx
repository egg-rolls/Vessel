/**
 * Team 域入口：按 hash 路由渲染列表 / 群聊 / 成员详情。
 *
 * 只使用 AppShell 注入的 `navigate` 与全局 `useConnection` / `EventStore`；
 * 不新增路由库、状态库或第二套事件总线。
 */
import type { Route } from '../../app/router';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { t } from '../../i18n';
import { MemberDetail } from './MemberDetail';
import { TeamChat } from './TeamChat';
import { TeamList } from './TeamList';

export interface TeamViewProps {
  route: Extract<Route, { domain: 'team' }>;
  navigate: (route: Route) => void;
}

export function TeamView({ route, navigate }: TeamViewProps) {
  const { client, hasToken, connectionState, epoch, tenantEpoch, tenantId, permissions, asks } =
    useConnection();
  const snapshot = useEventSnapshot();

  const teamId = 'teamId' in route ? route.teamId : undefined;
  const memberId = 'memberId' in route ? route.memberId : undefined;
  const bodyId = 'bodyId' in route ? route.bodyId : undefined;

  if (!teamId) {
    return (
      <div className="team-workspace team-workspace-list">
        <TeamList
          client={client}
          hasToken={hasToken}
          epoch={epoch}
          tenantEpoch={tenantEpoch}
          tenantId={tenantId}
          onOpen={(id) => navigate({ domain: 'team', teamId: id })}
        />
      </div>
    );
  }

  if (memberId) {
    return (
      <div className="team-workspace team-workspace-detail">
        <MemberDetail
          client={client}
          hasToken={hasToken}
          epoch={epoch}
          tenantEpoch={tenantEpoch}
          teamId={teamId}
          memberId={memberId}
          {...(bodyId ? { bodyId } : {})}
          events={snapshot.entries}
          onBack={() => navigate({ domain: 'team', teamId })}
          onBackToMember={() => navigate({ domain: 'team', teamId, memberId })}
          onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
          onOpenBody={(sessionId) =>
            navigate({ domain: 'team', teamId, memberId, bodyId: sessionId })
          }
        />
      </div>
    );
  }

  return (
    <div className="team-workspace">
      <aside className="team-list-column" aria-label={t('team.list.title')}>
        <TeamList
          client={client}
          hasToken={hasToken}
          epoch={epoch}
          tenantEpoch={tenantEpoch}
          tenantId={tenantId}
          selectedTeamId={teamId}
          standalone={false}
          onOpen={(id) => navigate({ domain: 'team', teamId: id })}
        />
      </aside>
      <TeamChat
        key={teamId}
        client={client}
        hasToken={hasToken}
        connectionState={connectionState}
        epoch={epoch}
        tenantEpoch={tenantEpoch}
        teamId={teamId}
        permissions={permissions}
        asks={asks}
        events={snapshot.entries}
        onOpenMember={(agentId) => navigate({ domain: 'team', teamId, memberId: agentId })}
        onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
        onBackToList={() => navigate({ domain: 'team' })}
      />
    </div>
  );
}
