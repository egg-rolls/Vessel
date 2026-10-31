/**
 * 单个 Team 卡片：名称 / id / 成员 / 在线 / 描述 / 归档标记 + 右侧 ActionMenu。
 */
import { ActionMenu, type ActionMenuItem } from '../../components/ActionMenu';
import type { NodeView } from '../../gateway/NodeProvider';
import type { TeamSummary } from '../../gateway/types';
import { t } from '../../i18n';

interface TeamCardProps {
  node: NodeView;
  team: TeamSummary;
  menuItems: (node: NodeView, team: TeamSummary) => ActionMenuItem[];
  onOpen: (node: NodeView, team: TeamSummary) => void;
}

export function TeamCard({ node, team, menuItems, onOpen }: TeamCardProps) {
  return (
    <li className="teams-card">
      <button
        type="button"
        className="teams-card-open"
        title={t('teams.card.open')}
        onClick={() => onOpen(node, team)}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-semibold">{team.name || team.team_id}</span>
          {team.archived_at !== undefined && (
            <span className="whitespace-nowrap rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
              {t('teams.card.archived')}
            </span>
          )}
        </span>
        <span className="wrap-anywhere font-mono text-xs text-faint">{team.team_id}</span>
        <span className="flex flex-wrap gap-3 text-sm text-muted">
          <span>{t('teams.card.members', { members: team.member_count })}</span>
          <span>
            {team.online_count !== undefined
              ? t('teams.card.online', { online: team.online_count })
              : '—'}
          </span>
        </span>
        {team.description && (
          <span className="line-clamp-2 text-sm text-muted">{team.description}</span>
        )}
      </button>
      <ActionMenu
        className="teams-card-menu"
        label={`${t('common.moreActions')}: ${team.name || team.team_id}`}
        items={menuItems(node, team)}
      />
    </li>
  );
}
