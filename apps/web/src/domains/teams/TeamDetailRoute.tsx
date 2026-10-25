/**
 * Team 详情路由：群聊 / 成员详情 + Edit / Archive。
 *
 * Edit 使用整页 `TeamEditView`（hash 末尾 `/edit`）；Archive 走警告确认。
 * 归档 Team 只读：隐藏写入入口，TeamChat 自己禁用发送。
 */
import { useEffect, useState } from 'react';
import { formatRoute, type Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/ToastProvider';
import { Badge, Button } from '../../components/ui';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { MemberDetail } from '../team/MemberDetail';
import { TeamChat } from '../team/TeamChat';
import { TeamEditView } from './TeamEditView';
import { TeamNodeBadge } from './TeamNodeBadge';
import { isTeamEditHash, teamEditHash } from './team-url';

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
  const toast = useToast();
  const { connectionState, epoch, tenantEpoch, permissions, asks } = useConnection();
  const { teamControl, hasTokenFor } = useNodes();
  const snapshot = useEventSnapshot();
  const control = teamControl(node);
  const hasToken = hasTokenFor(node);
  const [editing, setEditing] = useState(() =>
    isTeamEditHash(window.location.hash, route.nodeKey, route.teamId),
  );
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [revision, setRevision] = useState(0);

  const teamDetail = useResource({
    load: () => control.getTeam(route.teamId, { limit: 1, members_limit: 1 }),
    enabled: hasToken,
    deps: [epoch, tenantEpoch, nodeKeyOf(node), route.teamId],
  });
  const summary = resourceData(teamDetail.state)?.team;
  const archived = summary?.archived_at !== undefined;

  useEffect(() => {
    const sync = () =>
      setEditing(isTeamEditHash(window.location.hash, route.nodeKey, route.teamId));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [route.nodeKey, route.teamId]);

  const openEdit = () => {
    window.location.hash = teamEditHash(route.nodeKey, route.teamId);
  };
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
        onSaved={() => teamDetail.reload()}
      />
    );
  }

  const currentEvents = node.current ? snapshot.entries : [];
  const currentPermissions = node.current ? permissions : [];
  const currentAsks = node.current ? asks : [];

  const confirmArchive = async () => {
    if (!summary) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const saved = await control.archiveTeam(route.teamId);
      toast.success(`${saved.name || saved.team_id}: ${t('nodes.teams.archived')}`);
      setArchiveOpen(false);
      setRevision((value) => value + 1);
      teamDetail.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setArchiveError(message);
    } finally {
      setArchiving(false);
    }
  };

  const toggleFreeze = async () => {
    if (!summary || freezing) return;
    const next = summary.spawn_frozen !== true;
    setFreezing(true);
    try {
      await control.setSpawnFrozen(route.teamId, next);
      toast.success(next ? t('teams.frozen') : t('teams.unfrozen'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFreezing(false);
      teamDetail.reload();
    }
  };

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
        <div className="inline-flex flex-wrap gap-2">
          <Button size="small" disabled={!hasToken || archived} onClick={openEdit}>
            {t('common.edit')}
          </Button>
          <Button
            size="small"
            disabled={!hasToken || archived || !summary || freezing}
            onClick={() => {
              void toggleFreeze();
            }}
          >
            {summary?.spawn_frozen === true ? t('teams.unfreeze') : t('teams.freeze')}
          </Button>
          <Button
            size="small"
            variant="dangerGhost"
            disabled={!hasToken || archived || !summary}
            onClick={() => {
              setArchiveError(null);
              setArchiveOpen(true);
            }}
          >
            {t('common.archive')}
          </Button>
        </div>
      </div>
      <TeamChat
        key={`${route.teamId}:${revision}`}
        client={control}
        hasToken={hasToken}
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

      {archiveOpen && summary && (
        <ConfirmDialog
          title={t('nodes.teams.archiveTitle')}
          body={
            <>
              <p>{t('nodes.teams.archiveBody')}</p>
              <p className="font-mono">{summary.name || summary.team_id}</p>
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
            setArchiveOpen(false);
            setArchiveError(null);
          }}
        />
      )}
    </div>
  );
}
