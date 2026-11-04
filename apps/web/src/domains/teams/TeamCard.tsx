/**
 * 单个 Team 卡片：名称 / 成员 / 在线 / 归档标记 + 右侧 ActionMenu。
 *
 * id 与描述不进卡片（DESIGN-0.33.0 §4 step 3）：
 * - `team_id` 属 Detail 槽 —— 需要时走 ActionMenu「复制团队 ID」，不再常显占一行；
 * - 可选描述会让卡高在 2/4 行之间跳动，破坏列表的等高扫描。
 */
import { ActionMenu, type ActionMenuItem } from '../../components/ActionMenu';
import { Badge } from '../../components/ui';
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
          {team.archived_at !== undefined && <Badge tone="warn">{t('teams.card.archived')}</Badge>}
        </span>
        <span className="flex flex-wrap gap-3 text-sm text-muted">
          <span>{t('teams.card.members', { members: team.member_count })}</span>
          <span>
            {team.online_count !== undefined
              ? t('teams.card.online', { online: team.online_count })
              : '—'}
          </span>
        </span>
      </button>
      <ActionMenu
        className="teams-card-menu"
        label={`${t('common.moreActions')}: ${team.name || team.team_id}`}
        items={menuItems(node, team)}
      />
    </li>
  );
}
