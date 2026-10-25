/**
 * Team 成员侧栏：presence / engine state / attention / Body 入口。
 *
 * 顺序唯一来源是服务端 `teams.get` 的 `members` 窗口（DECISION-038 §2.3：
 * live → last_seen desc → name），这里**不得重新排序**。
 * `left` 成员整行降透明度，只保留查看动作。
 */
import { ActionMenu } from '../../components/ActionMenu';
import { StatusChip } from '../../components/StatusChip';
import { iconButtonClass } from '../../components/Tooltip';
import { Badge } from '../../components/ui';
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="column-header team-members-head">
        <span className="column-title">{t('team.chat.members')}</span>
        <span className="ml-0.5 font-mono text-2xs text-faint">
          {members.length} / {totalCount}
        </span>
        {onClose && (
          <button
            type="button"
            className={`${iconButtonClass} ml-auto`}
            aria-label={t('team.a11y.closeMembers')}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      <ul
        className="flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-3"
        aria-label={t('team.a11y.memberList')}
      >
        {members.map((member) => {
          const status = memberStatus(member);
          const sessionId = member.session_id;
          const attention = attentionCount(member, permissions, asks);
          const name = member.name?.trim() || shortAgentId(member.agent_id);
          const left = member.membership === 'left';
          return (
            <li
              key={member.agent_id}
              className={`team-member-row flex items-center gap-1.5 rounded-sm px-1.5 py-1.25 hover:bg-hover ${
                left ? 'opacity-70' : ''
              } ${activeMemberId === member.agent_id ? 'bg-accent-soft' : ''}`.trim()}
            >
              <span
                className="grid size-7 flex-none place-items-center rounded-full bg-sunken font-mono text-xs uppercase text-muted"
                aria-hidden="true"
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent px-0 py-0.5 text-left text-inherit"
                onClick={() => onOpenMember(member.agent_id)}
                aria-label={name}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm">{name}</span>
                  <Badge className="flex-none">
                    {member.owner !== undefined
                      ? t('team.member.contractor')
                      : t('team.member.peer')}
                  </Badge>
                  <span
                    role="img"
                    className={`size-1.5 flex-none rounded-full ${
                      member.presence === 'live'
                        ? 'bg-success'
                        : 'border border-faint bg-transparent'
                    }`}
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
                <span className="truncate text-2xs text-faint">{t(status.labelKey)}</span>
              </button>
              {attention > 0 && sessionId && (
                <button
                  type="button"
                  className="h-4.5 min-w-4.5 flex-none cursor-pointer rounded-full border border-warn bg-warn-soft px-1.25 font-mono text-2xs leading-4 text-warn"
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
