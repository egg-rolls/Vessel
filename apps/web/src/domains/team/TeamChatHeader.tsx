import { Badge, Button, EntityHeader } from '../../components/ui';
import type { TeamSummary } from '../../gateway/types';
import { t } from '../../i18n';

export interface TeamChatHeaderProps {
  team: TeamSummary | undefined;
  /**
   * 已不进 Identity 槽（DESIGN-0.33.0 I4「id 0 命中」）：缺名时标题走
   * `entity.unnamed` 占位，team_id 的可达性由 ActionMenu「复制团队 ID」承担。
   * 保留在签名里是为了不让调用方跟着改。
   */
  teamId: string;
  archived: boolean;
  /** 父级节点显示名（scope 槽）；缺省则不渲染从属行。 */
  nodeName?: string;
  /** 父级就是当前连接的节点。 */
  nodeCurrent?: boolean;
  /** 团队被冻结（status 槽，与 archived 并列）。 */
  frozen?: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
  onBackToList: () => void;
  onRefresh: () => void;
  hasToken: boolean;
  refreshing: boolean;
}

export function TeamChatHeader({
  team,
  archived,
  nodeName,
  nodeCurrent = false,
  frozen = false,
  membersOpen,
  onToggleMembers,
  onBackToList,
  onRefresh,
  hasToken,
  refreshing,
}: TeamChatHeaderProps) {
  return (
    <header className="team-chat-head">
      <EntityHeader
        title={team?.name?.trim() || t('entity.unnamed')}
        scope={nodeName ? [{ label: nodeName }] : []}
        current={nodeCurrent}
        status={
          archived || frozen ? (
            <>
              {archived && <Badge tone="warn">{t('teams.chat.archived')}</Badge>}
              {frozen && <Badge tone="warn">{t('teams.frozen')}</Badge>}
            </>
          ) : undefined
        }
        actions={
          <>
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
          </>
        }
      />
    </header>
  );
}
