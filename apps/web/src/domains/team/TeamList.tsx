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
import { Button, Input } from '../../components/ui';
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

export function matchesQuery(team: TeamSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    team.name.toLowerCase().includes(needle) ||
    team.team_id.toLowerCase().includes(needle) ||
    (team.workspace?.toLowerCase().includes(needle) ?? false)
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
      <div className="flex h-full min-h-0 flex-col">
        {title}
        <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
      </div>
    );
  }

  return (
    <div
      className={`flex min-h-0 flex-col ${standalone ? 'team-list-standalone h-auto' : 'h-full'}`}
    >
      {title}
      <div className="flex flex-none flex-col gap-2 px-3.5 pb-2.5">
        <Input
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
              action={<Button onClick={() => setQuery('')}>{t('team.list.clearSearch')}</Button>}
            />
          ) : (
            <ul className="team-list-scroll">
              {filtered.map((team) => (
                <li
                  key={team.team_id}
                  className={`team-list-item group flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-hover${
                    selectedTeamId === team.team_id ? ' bg-accent-soft' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-sm border-0 bg-transparent px-2.5 py-2 text-left text-inherit"
                    onClick={() => onOpen(team.team_id)}
                    aria-current={selectedTeamId === team.team_id ? 'true' : undefined}
                  >
                    <span className="flex min-w-0 items-baseline justify-between gap-2.5">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {team.name || team.team_id}
                      </span>
                      <span className="flex flex-none gap-2 text-xs text-muted">
                        <span>{t('team.list.memberCount', { count: team.member_count })}</span>
                        <span className="text-muted">
                          {team.online_count !== undefined
                            ? t('team.list.onlineCount', { count: team.online_count })
                            : '—'}
                        </span>
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-xs text-faint">
                      <span className="truncate font-mono" title={team.workspace}>
                        {team.workspace || '—'}
                      </span>
                    </span>
                  </button>
                  <ActionMenu
                    className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
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
