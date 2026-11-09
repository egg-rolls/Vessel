/**
 * Team 成员弹层：页头「查看成员列表」入口。
 *
 * 成员列表不再常驻详情；弹层内按名字 / agent_id / 角色过滤，列表复用
 * TeamMemberSidebar（presence、权限提示、Body 入口保持不变）。
 */
import { useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { EmptyState, LoadingState } from '../../components/States';
import { Button, SearchInput } from '../../components/ui';
import type { AskUserRequest, PermissionRequest, TeamMember } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { shortAgentId } from './mention';
import { roleLabelKey, roleOf } from './role';
import { TeamMemberSidebar } from './TeamMemberSidebar';
import type { MemberWindowFlags } from './team-window';

export interface TeamMembersDialogProps {
  members: readonly TeamMember[];
  memberTotal: number;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  memberWindow: MemberWindowFlags;
  /** `useTeamChat` 的首次加载态；弹层打开时可能仍在拉取。 */
  loading: boolean;
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onLoadMore: () => void;
  onClose: () => void;
}

function matchesMember(member: TeamMember, query: string): boolean {
  const name = (member.name?.trim() || shortAgentId(member.agent_id)).toLowerCase();
  const role = roleOf(member);
  return (
    name.includes(query) ||
    member.agent_id.toLowerCase().includes(query) ||
    role.includes(query) ||
    t(roleLabelKey(role)).toLowerCase().includes(query)
  );
}

export function TeamMembersDialog({
  members,
  memberTotal,
  permissions,
  asks,
  memberWindow,
  loading,
  onOpenMember,
  onOpenSession,
  onLoadMore,
  onClose,
}: TeamMembersDialogProps) {
  // 订阅 locale：切换语言时角色过滤结果随之更新。
  useLocale();
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? members.filter((member) => matchesMember(member, normalized))
    : members;

  return (
    <ModalShell
      label={t('team.chat.members')}
      onClose={onClose}
      closeLabel={t('common.close')}
      size="md"
    >
      <h2 className="modal-title">{t('team.chat.members')}</h2>
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t('team.members.search')}
        ariaLabel={t('team.members.search')}
      />
      {loading ? (
        <LoadingState rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('team.members.empty')} />
      ) : (
        <TeamMemberSidebar
          members={filtered}
          total={normalized ? filtered.length : memberTotal}
          permissions={permissions}
          asks={asks}
          onOpenMember={onOpenMember}
          onOpenSession={onOpenSession}
        />
      )}
      {memberWindow.canLoadMore && (
        <Button size="small" onClick={onLoadMore}>
          {t('team.chat.loadMoreMembers')}
        </Button>
      )}
      {memberWindow.capped && (
        <p className="m-0 self-center font-mono text-xs text-faint" role="status">
          {t('team.chat.membersCapped', { shown: members.length, total: memberTotal })}
        </p>
      )}
    </ModalShell>
  );
}
