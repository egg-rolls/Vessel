/**
 * 单个 Team 卡片：名称 / 成员 / 在线 / 归档标记 + 右侧 ActionMenu。
 *
 * id 与描述不进卡片（DESIGN-0.33.0 §4 step 3）：
 * - `team_id` 属 Detail 槽 —— 需要时走 ActionMenu「复制团队 ID」，不再常显占一行；
 * - 可选描述会让卡高在 2/4 行之间跳动，破坏列表的等高扫描。
 */
import { ActionMenu, type ActionMenuItem } from '../../components/ActionMenu';
import { Badge, SidebarEntityCard } from '../../components/ui';
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
    <SidebarEntityCard
      as="li"
      titleText={t('teams.card.open')}
      onClick={() => onOpen(node, team)}
      title={
        <>
          <span className="min-w-0 truncate">{team.name || team.team_id}</span>
          {team.archived_at !== undefined && <Badge tone="warn">{t('teams.card.archived')}</Badge>}
        </>
      }
      meta={
        <>
          <span>{t('teams.card.members', { members: team.member_count })}</span>
          <span>
            {team.online_count !== undefined
              ? t('teams.card.online', { online: team.online_count })
              : '—'}
          </span>
        </>
      }
      trailing={
        <ActionMenu
          className="items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-compact:opacity-100"
          label={`${t('common.moreActions')}: ${team.name || team.team_id}`}
          items={menuItems(node, team)}
        />
      }
    />
  );
}
