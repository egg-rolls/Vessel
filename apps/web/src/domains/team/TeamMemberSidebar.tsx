/**
 * Team 成员侧栏：presence / engine state / attention / Body 入口。
 *
 * 顺序唯一来源是服务端 `teams.get` 的 `members` 窗口（DECISION-038 §2.3：
 * live → last_seen desc → name），这里**不得重新排序**。
 * `left` 成员整行降透明度，只保留查看动作。
 */
import { ActionMenu } from '../../components/ActionMenu';
import { StatusChip } from '../../components/StatusChip';
import type { AskUserRequest, PermissionRequest, TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import { memberStatus } from './member-status';
import { shortAgentId } from './mention';

export function attentionCount(
  member: TeamMember,
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): number {
  const sessionId = member.session_id;
  if (!sessionId) return 0;
  const pendingPermissions = permissions.filter((item) => item.sessionId === sessionId).length;
  const pendingAsks = asks.filter((item) => item.sessionId === sessionId).length;
  return pendingPermissions + pendingAsks;
}

function copyAgentId(agentId: string): void {
  void navigator.clipboard?.writeText(agentId).catch(() => undefined);
}

export interface TeamMemberSidebarProps {
  members: readonly TeamMember[];
  /** `team.member_count`（完整 present 总数）；缺失时退化为当前窗口长度。 */
  total?: number;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  activeMemberId?: string;
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onClose?: () => void;
}

export function TeamMemberSidebar({
  members,
  total,
  permissions,
  asks,
  activeMemberId,
  onOpenMember,
  onOpenSession,
  onClose,
}: TeamMemberSidebarProps) {
  const totalCount = total ?? members.length;

  return (
    <div className="team-members">
      <div className="column-header team-members-head">
        <span className="column-title">{t('team.chat.members')}</span>
        <span className="team-members-count dim mono">
          {members.length} / {totalCount}
        </span>
        {onClose && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t('team.a11y.closeMembers')}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      <ul className="team-members-scroll" aria-label={t('team.a11y.memberList')}>
        {members.map((member) => {
          const status = memberStatus(member);
          const sessionId = member.session_id;
          const attention = attentionCount(member, permissions, asks);
          const name = member.name?.trim() || shortAgentId(member.agent_id);
          const left = member.membership === 'left';
          return (
            <li
              key={member.agent_id}
              className={`team-member-row ${left ? 'left' : ''} ${
                activeMemberId === member.agent_id ? 'selected' : ''
              }`.trim()}
            >
              <span className="team-avatar" aria-hidden="true">
                {name.slice(0, 1).toUpperCase()}
              </span>
              <button
                type="button"
                className="team-member-main"
                onClick={() => onOpenMember(member.agent_id)}
                aria-label={name}
              >
                <span className="team-member-name-line">
                  <span className="team-member-name">{name}</span>
                  <span
                    role="img"
                    className={`team-presence-dot ${member.presence}`}
                    aria-label={
                      member.presence === 'live' ? t('team.presence.live') : t('team.presence.gone')
                    }
                  />
                  <StatusChip
                    status={status.chipStatus}
                    label={t(status.labelKey)}
                    title={status.titleKey ? t(status.titleKey) : undefined}
                  />
                </span>
                <span className="team-member-sub mono">{t(status.labelKey)}</span>
              </button>
              {attention > 0 && sessionId && (
                <button
                  type="button"
                  className="team-attention-badge"
                  title={t('team.attention.pending')}
                  aria-label={t('team.attention.count', { count: attention })}
                  onClick={() => onOpenSession(sessionId)}
                >
                  {attention}
                </button>
              )}
              <ActionMenu
                label={t('team.member.title')}
                items={[
                  {
                    id: 'details',
                    label: t('breadcrumb.team.member'),
                    onSelect: () => onOpenMember(member.agent_id),
                  },
                  // left 成员只保留查看详情。
                  ...(left
                    ? []
                    : [
                        {
                          id: 'session',
                          label: t('team.member.currentSession'),
                          disabled: !sessionId,
                          onSelect: () => {
                            if (sessionId) onOpenSession(sessionId);
                          },
                        },
                        {
                          id: 'copy-id',
                          label: 'agent_id',
                          onSelect: () => copyAgentId(member.agent_id),
                        },
                      ]),
                ]}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
