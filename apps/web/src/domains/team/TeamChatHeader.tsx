import { Button } from '../../components/ui';
import type { TeamSummary } from '../../gateway/types';
import { t } from '../../i18n';

export interface TeamChatHeaderProps {
  team: TeamSummary | undefined;
  teamId: string;
  archived: boolean;
  membersShown: number;
  memberTotal: number;
  onlineCount: number;
  membersOpen: boolean;
  onToggleMembers: () => void;
  onBackToList: () => void;
  onRefresh: () => void;
  hasToken: boolean;
  refreshing: boolean;
}

export function TeamChatHeader({
  team,
  teamId,
  archived,
  membersShown,
  memberTotal,
  onlineCount,
  membersOpen,
  onToggleMembers,
  onBackToList,
  onRefresh,
  hasToken,
  refreshing,
}: TeamChatHeaderProps) {
  return (
    <header className="team-chat-head">
      <div className="min-w-0">
        <h1 className="font-serif text-title font-semibold wrap-anywhere">
          {team?.name || teamId}
        </h1>
        <div className="mt-1.25 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="font-mono text-2xs text-faint">{teamId}</span>
          {team?.workspace && (
            <span className="max-w-80 truncate font-mono" title={team.workspace}>
              {team.workspace}
            </span>
          )}
          <span>
            {t('team.chat.descriptionLabel')}: {team?.description || '—'}
          </span>
          {archived && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
              {t('teams.chat.archived')}
              <span className="text-xs text-faint"> {t('teams.chat.archivedHint')}</span>
            </span>
          )}
          <span>{t('team.chat.memberWindow', { shown: membersShown, total: memberTotal })}</span>
          <span>{t('team.chat.onlineCount', { count: onlineCount })}</span>
        </div>
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-1.5">
        <Button
          id="team-members-toggle"
          className="team-chat-members-toggle hidden max-wide:inline-flex"
          aria-expanded={membersOpen}
          aria-controls="team-members"
          onClick={onToggleMembers}
        >
          {membersOpen ? t('team.a11y.closeMembers') : t('team.chat.members')}
        </Button>
        <Button className="team-chat-back hidden max-wide:inline-flex" onClick={onBackToList}>
          {t('team.chat.backToList')}
        </Button>
        <Button onClick={onRefresh} disabled={!hasToken || refreshing}>
          {refreshing ? t('team.chat.refreshing') : t('team.chat.refresh')}
        </Button>
      </div>
    </header>
  );
}
