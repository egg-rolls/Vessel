/**
 * Team 列表：`teams.list` + 本地搜索。
 *
 * 桌面三栏时作为左侧导航列；`#/team` 独立路由时使用 PageHeader。
 * `online_count` 只来自服务端；缺失显示 `—`，不逐 Team 拉详情反推。
 */
import { useMemo, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { PageHeader } from '../../components/PageHeader';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import type { TeamSummary } from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';

export interface TeamListClient {
  listTeams(): Promise<TeamSummary[]>;
}

export interface TeamListProps {
  client: TeamListClient;
  hasToken: boolean;
  epoch: number;
  tenantEpoch: number;
  tenantId?: string | null;
  selectedTeamId?: string;
  onOpen: (teamId: string) => void;
  /** false 时渲染为三栏的左侧列（无 PageHeader）。 */
  standalone?: boolean;
  /** 测试 / 预览注入，避免 SSR 依赖 effect。 */
  initialTeams?: TeamSummary[];
  initialError?: { message: string; code?: string };
}

function matchesQuery(team: TeamSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    team.name.toLowerCase().includes(needle) ||
    team.team_id.toLowerCase().includes(needle) ||
    team.workspace.toLowerCase().includes(needle)
  );
}

export function TeamList({
  client,
  hasToken,
  epoch,
  tenantEpoch,
  tenantId,
  selectedTeamId,
  onOpen,
  standalone = true,
  initialTeams,
  initialError,
}: TeamListProps) {
  const [query, setQuery] = useState('');
  const resource = useResource({
    load: () => client.listTeams(),
    enabled: hasToken,
    pollMs: 15_000,
    deps: [epoch, tenantEpoch],
    ...(initialTeams !== undefined ? { initialData: initialTeams } : {}),
  });

  const data = resourceData(resource.state);
  const teams = data ?? [];
  const loaded = data !== undefined;
  const stateError =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : undefined;
  const error = stateError ?? initialError;
  const filtered = useMemo(() => teams.filter((team) => matchesQuery(team, query)), [teams, query]);

  const title = standalone ? (
    <PageHeader
      title={t('team.list.title')}
      description={t('team.list.description')}
      tenantId={tenantId}
    />
  ) : (
    <div className="column-header">
      <span className="column-title">{t('team.list.title')}</span>
    </div>
  );

  if (!hasToken) {
    return (
      <div className="team-list">
        {title}
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  return (
    <div className={`team-list ${standalone ? 'team-list-standalone' : ''}`.trim()}>
      {title}
      <div className="team-list-controls">
        <input
          className="input team-list-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('team.list.search')}
          aria-label={t('team.list.search')}
          spellCheck={false}
        />
      </div>

      {error && !loaded ? (
        error.code === 'not_found' ? (
          <NotEnabledState
            title={t('team.error.notEnabled')}
            reason={t('team.error.notEnabledReason')}
            hint={t('team.error.notEnabledHint')}
          />
        ) : (
          <ErrorState message={error.message} onRetry={resource.reload} />
        )
      ) : !loaded ? (
        <LoadingState rows={3} />
      ) : (
        <>
          {error && <StaleNotice message={t('team.error.stale')} onRetry={resource.reload} />}
          {teams.length === 0 ? (
            <EmptyState title={t('team.list.empty')} description={t('team.list.description')} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={t('team.list.emptyFiltered', { query: query.trim() })}
              action={
                <button type="button" className="btn" onClick={() => setQuery('')}>
                  {t('team.list.clearSearch')}
                </button>
              }
            />
          ) : (
            <ul className="team-list-scroll">
              {filtered.map((team) => (
                <li
                  key={team.team_id}
                  className={`team-list-item ${selectedTeamId === team.team_id ? 'selected' : ''}`.trim()}
                >
                  <button
                    type="button"
                    className="team-list-main"
                    onClick={() => onOpen(team.team_id)}
                    aria-current={selectedTeamId === team.team_id ? 'true' : undefined}
                  >
                    <span className="team-list-name-line">
                      <span className="team-list-name">{team.name || team.team_id}</span>
                      <span className="team-list-counts mono">
                        <span>{t('team.list.memberCount', { count: team.member_count })}</span>
                        <span className="dim">
                          {team.online_count !== undefined
                            ? t('team.list.onlineCount', { count: team.online_count })
                            : '—'}
                        </span>
                      </span>
                    </span>
                    <span className="team-list-sub">
                      <span className="team-list-workspace mono" title={team.workspace}>
                        {team.workspace || '—'}
                      </span>
                    </span>
                  </button>
                  <ActionMenu
                    label={t('team.list.open')}
                    items={[
                      {
                        id: 'open',
                        label: t('team.list.open'),
                        onSelect: () => onOpen(team.team_id),
                      },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
