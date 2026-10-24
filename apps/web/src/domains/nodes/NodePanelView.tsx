/**
 * Nodes → 单节点面板（0.24 Web IA）。
 *
 * 一个节点上的健康 / 实例信息 / Team 增删改 / Agent roster。
 * 数据只走 canonical RPC：`health.get`、`teams.list`、`teams.get`；
 * 写操作经 `TeamControl`，不在这里复制 Team 逻辑，也不新增 RPC。
 */
import { type ReactNode, useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { ActionMenu } from '../../components/ActionMenu';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { fetchNodeRoster } from '../../gateway/team-roster';
import type { TeamSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { TeamFormDialog } from './TeamFormDialog';

type NodesRoute = Extract<Route, { domain: 'nodes' }>;
type NodeForm = { mode: 'create' } | { mode: 'edit'; team: TeamSummary };

export interface NodePanelViewProps {
  route: NodesRoute;
  navigate: (route: Route) => void;
}

/** `health.node.status` → StatusChip 的语义色。 */
function statusOfNode(raw: string): string {
  if (raw === 'busy') return 'running';
  if (raw === 'draining') return 'cancelling';
  return 'pending';
}

/**
 * Team 列表 / roster 的失败映射：节点不暴露 teams.*（not_found / method_not_allowed）
 * 与无权限（forbidden）用 NotEnabledState，其它错误保留重试。
 */
function ResourceFailure({
  code,
  message,
  onRetry,
}: {
  code?: string;
  message: string;
  onRetry: () => void;
}) {
  if (code === 'not_found' || code === 'method_not_allowed' || code === 'not_enabled') {
    return <NotEnabledState title={t('nodes.error.notEnabled')} reason={message} />;
  }
  if (code === 'forbidden') {
    return <NotEnabledState title={t('nodes.error.forbidden')} reason={message} />;
  }
  return <ErrorState message={message} onRetry={onRetry} />;
}

export function NodePanelView({ route, navigate }: NodePanelViewProps) {
  useLocale();
  const { nodes } = useNodes();
  const { tenantId } = useConnection();
  const nodeKey = route.nodeKey;
  const node =
    nodeKey === undefined ? undefined : nodes.find((item) => nodeKeyOf(item) === nodeKey);

  if (nodeKey === undefined) {
    return (
      <div className="settings-section">
        <PageHeader
          title={t('nodes.title')}
          description={t('nodes.description')}
          tenantId={tenantId}
        />
        {nodes.length === 0 ? (
          <NotEnabledState title={t('nodes.empty')} reason={t('nodes.emptyHint')} />
        ) : (
          <section className="panel">
            <h2 className="section-title">{t('nodes.picker.title')}</h2>
            <ul className="nodes-picker">
              {nodes.map((item) => (
                <li className="nodes-picker-item" key={nodeKeyOf(item)}>
                  <button
                    type="button"
                    className="nodes-picker-row"
                    onClick={() => navigate({ domain: 'nodes', nodeKey: nodeKeyOf(item) })}
                  >
                    <span className="nodes-picker-name">{item.name}</span>
                    {item.current && (
                      <span className="nodes-current-badge">{t('nodes.current')}</span>
                    )}
                    <span className="nodes-picker-id mono dim">{item.nodeId ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  if (!node) {
    return (
      <div className="settings-section">
        <PageHeader
          title={t('nodes.title')}
          description={t('nodes.description')}
          tenantId={tenantId}
        />
        <NotEnabledState
          title={t('nodes.notFound')}
          reason={t('nodes.notFoundHint')}
          action={
            <Button variant="primary" onClick={() => navigate({ domain: 'nodes' })}>
              {t('nodes.back')}
            </Button>
          }
        />
      </div>
    );
  }

  return <NodeDetail node={node} navigate={navigate} />;
}

function NodeDetail({ node, navigate }: { node: NodeView; navigate: (route: Route) => void }) {
  useLocale();
  const toast = useToast();
  const { fetchHealth, teamControl, hasTokenFor } = useNodes();
  const { epoch, tenantEpoch, tenantId, hello } = useConnection();
  const nodeKey = nodeKeyOf(node);
  const control = useMemo(() => teamControl(node), [teamControl, node]);
  const hasToken = hasTokenFor(node);

  const [form, setForm] = useState<NodeForm | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TeamSummary | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const health = useResource({
    load: () => fetchHealth(node),
    pollMs: 15_000,
    deps: [epoch, nodeKey],
  });
  const teams = useResource({
    load: () => control.listTeams(),
    pollMs: 15_000,
    deps: [epoch, tenantEpoch, nodeKey],
  });
  const roster = useResource({
    load: () => fetchNodeRoster(node, control),
    pollMs: 20_000,
    deps: [epoch, tenantEpoch, nodeKey],
  });

  const healthData = resourceData(health.state);
  const teamsData = resourceData(teams.state);
  const rosterData = resourceData(roster.state);

  const healthFailed = health.state.status === 'error';
  const healthLoading = !healthData && !healthFailed;
  const healthStatus = healthFailed ? 'unreachable' : healthData ? 'connected' : 'pending';
  const healthLabel = healthFailed
    ? t('nodes.health.error')
    : healthData
      ? t('nodes.health.ok')
      : t('nodes.health.loading');
  const dataPlane = healthFailed
    ? t('nodes.dataPlane.unreachable')
    : healthData
      ? t('nodes.dataPlane.direct')
      : t('nodes.health.loading');

  const teamsFailure =
    teams.state.status === 'error' ? { code: teams.state.code, message: teams.state.error } : null;
  const rosterFailure =
    roster.state.status === 'error'
      ? { code: roster.state.code, message: roster.state.error }
      : rosterData && !rosterData.ok
        ? { code: rosterData.code, message: rosterData.error ?? t('common.loadFailed') }
        : null;
  const rosters = rosterData?.ok ? rosterData.rosters : [];
  const agentCount = rosters.reduce((total, entry) => total + entry.members.length, 0);

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await control.archiveTeam(archiveTarget.team_id);
      toast.success(`${archiveTarget.name || archiveTarget.team_id}: ${t('nodes.teams.archived')}`);
      setArchiveTarget(null);
      teams.reload();
      roster.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setArchiveError(message);
      toast.error(message);
    } finally {
      setArchiving(false);
    }
  };

  let teamsBody: ReactNode;
  if (teamsFailure) {
    teamsBody = (
      <ResourceFailure
        code={teamsFailure.code}
        message={teamsFailure.message}
        onRetry={teams.reload}
      />
    );
  } else if (!teamsData) {
    teamsBody = <LoadingState label={t('common.loading')} rows={2} />;
  } else if (teamsData.length === 0) {
    teamsBody = (
      <EmptyState title={t('nodes.teams.empty')} description={t('nodes.teams.emptyHint')} />
    );
  } else {
    teamsBody = (
      <ul className="nodes-list">
        {teamsData.map((team) => (
          <li className="nodes-row" key={team.team_id}>
            <div className="nodes-row-main">
              <span className="nodes-row-title">{team.name || team.team_id}</span>
              <span className="nodes-row-sub mono dim">{team.team_id}</span>
            </div>
            <span
              className="nodes-row-metric mono"
              title={`${t('nodes.field.online')} / ${t('nodes.field.teams')}`}
            >
              {team.online_count ?? '—'}/{team.member_count}
            </span>
            {team.archived_at !== undefined && (
              <span className="nodes-badge">{t('nodes.teams.archived')}</span>
            )}
            <span
              className="nodes-row-actions"
              title={!hasToken ? t('nodes.error.noTokenReason') : undefined}
            >
              <ActionMenu
                label={team.name || team.team_id}
                disabled={!hasToken}
                items={[
                  {
                    id: 'edit',
                    label: t('nodes.teams.edit'),
                    disabled: !hasToken,
                    onSelect: () => setForm({ mode: 'edit', team }),
                  },
                  {
                    id: 'archive',
                    label: t('nodes.teams.archive'),
                    danger: true,
                    disabled: !hasToken,
                    onSelect: () => {
                      setArchiveError(null);
                      setArchiveTarget(team);
                    },
                  },
                ]}
              />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  let agentsBody: ReactNode;
  if (rosterFailure) {
    agentsBody = (
      <ResourceFailure
        code={rosterFailure.code}
        message={rosterFailure.message}
        onRetry={roster.reload}
      />
    );
  } else if (!rosterData) {
    agentsBody = <LoadingState label={t('common.loading')} rows={2} />;
  } else if (agentCount === 0) {
    agentsBody = <EmptyState title={t('nodes.agents.empty')} />;
  } else {
    agentsBody = (
      <>
        {rosterData.partialErrors > 0 && (
          <p className="nodes-note" role="status">
            {t('agents.partialErrors', { count: rosterData.partialErrors })}
          </p>
        )}
        {rosters.map((entry) => (
          <div className="nodes-agent-group" key={entry.team.team_id}>
            <h3 className="nodes-agent-group-title">
              <span>{entry.team.name || entry.team.team_id}</span>
              <span className="dim">
                {t('nodes.agents.groupCount', { count: entry.members.length })}
              </span>
            </h3>
            <ul className="nodes-list">
              {entry.members.map((member) => (
                <li
                  className="nodes-row nodes-agent-row"
                  key={`${entry.team.team_id}:${member.agent_id}`}
                >
                  <span className="nodes-row-title">{member.name ?? member.agent_id}</span>
                  <span className="nodes-row-sub mono dim">{member.agent_id}</span>
                  {member.state ? (
                    <StatusChip status={member.state} />
                  ) : (
                    <span className="dim">—</span>
                  )}
                  <span className={`nodes-presence nodes-presence-${member.presence}`}>
                    {t(`agents.presence.${member.presence}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="settings-section">
      <PageHeader
        title={node.name}
        description={t('nodes.description')}
        tenantId={tenantId}
        actions={<Button onClick={() => navigate({ domain: 'nodes' })}>{t('nodes.back')}</Button>}
      />

      <section className="panel">
        <h2 className="section-title">{t('nodes.section.health')}</h2>
        <dl className="diag-list">
          <dt>{t('nodes.field.status')}</dt>
          <dd>
            <StatusChip status={healthStatus} label={healthLabel} />
          </dd>
          <dt>{t('nodes.section.dataPlane')}</dt>
          <dd>{dataPlane}</dd>
        </dl>
        <p className="nodes-derived dim">{t('nodes.dataPlane.derived')}</p>
        {health.state.status === 'error' && (
          <p className="field-error" role="alert">
            {health.state.error}
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">{t('nodes.section.instance')}</h2>
        {healthData ? (
          <dl className="diag-list">
            <dt>{t('nodes.field.nodeId')}</dt>
            <dd className="mono">{healthData.node.node_id || node.nodeId || '—'}</dd>
            <dt>{t('nodes.field.status')}</dt>
            <dd>
              <StatusChip
                status={statusOfNode(healthData.node.status)}
                label={healthData.node.status}
              />
            </dd>
            <dt>{t('nodes.field.pid')}</dt>
            <dd className="mono">{healthData.node.pid}</dd>
            <dt>{t('nodes.field.startedAt')}</dt>
            <dd className="mono">{formatTimestamp(healthData.node.started_at) || '—'}</dd>
            <dt>{t('nodes.field.endpoint')}</dt>
            <dd className="mono">{healthData.node.endpoint}</dd>
            <dt>{t('nodes.field.role')}</dt>
            <dd className="mono">{healthData.node.role}</dd>
            <dt>{t('nodes.field.protocol')}</dt>
            <dd className="mono">
              {healthData.protocol.name} v{healthData.protocol.version}
            </dd>
            <dt>{t('nodes.field.incarnation')}</dt>
            <dd className="mono">
              {node.current ? (
                (hello?.incarnation ?? (
                  <span className="dim">{t('nodes.incarnation.missing')}</span>
                ))
              ) : (
                <span className="dim">{t('nodes.incarnation.missing')}</span>
              )}
            </dd>
          </dl>
        ) : healthLoading ? (
          <LoadingState label={t('nodes.health.loading')} rows={2} />
        ) : (
          <p className="dim">—</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header nodes-panel-header">
          <h2 className="section-title">{t('nodes.teams.title')}</h2>
          <Button
            variant="primary"
            size="small"
            onClick={() => setForm({ mode: 'create' })}
            disabled={!hasToken}
            title={!hasToken ? t('nodes.error.noTokenReason') : undefined}
          >
            {t('nodes.teams.create')}
          </Button>
        </div>
        {!hasToken && (
          <div className="nodes-token-warning" title={t('nodes.error.noToken')}>
            <strong>{t('nodes.error.noToken')}</strong>
            <span>{t('nodes.error.noTokenReason')}</span>
          </div>
        )}
        {teamsBody}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('nodes.agents.title')}</h2>
        </div>
        {agentsBody}
      </section>

      {form && (
        <TeamFormDialog
          mode={form.mode}
          team={form.mode === 'edit' ? form.team : undefined}
          control={control}
          hasToken={hasToken}
          onClose={() => setForm(null)}
          onSaved={() => {
            teams.reload();
            roster.reload();
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={t('nodes.teams.archiveTitle')}
          body={
            <>
              <p>{t('nodes.teams.archiveBody')}</p>
              {archiveError && (
                <p className="field-error" role="alert">
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
