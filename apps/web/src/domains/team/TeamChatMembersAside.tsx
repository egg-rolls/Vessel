import type { RefObject } from 'react';
import type { AskUserRequest, PermissionRequest, TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import { TeamMemberSidebar } from './TeamMemberSidebar';
import type { MemberWindowFlags } from './team-window';

export interface TeamChatMembersAsideProps {
  members: readonly TeamMember[];
  memberTotal: number;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onClose: (() => void) | undefined;
  membersOpen: boolean;
  narrow: boolean;
  drawerRef: RefObject<HTMLElement | null>;
  memberWindow: MemberWindowFlags;
  onLoadMore: () => void;
  onCloseDrawer: () => void;
}

export function TeamChatMembersAside({
  members,
  memberTotal,
  permissions,
  asks,
  onOpenMember,
  onOpenSession,
  onClose,
  membersOpen,
  narrow,
  drawerRef,
  memberWindow,
  onLoadMore,
  onCloseDrawer,
}: TeamChatMembersAsideProps) {
  return (
    <>
      <aside
        id="team-members"
        ref={drawerRef}
        {...(narrow ? { role: 'dialog' as const, 'aria-modal': membersOpen } : {})}
        className={`team-members-column ${membersOpen ? 'open' : ''}`.trim()}
        aria-label={t('team.a11y.memberList')}
        inert={narrow && !membersOpen ? true : undefined}
        aria-hidden={narrow && !membersOpen ? true : undefined}
      >
        <TeamMemberSidebar
          members={members}
          total={memberTotal}
          permissions={permissions}
          asks={asks}
          onOpenMember={onOpenMember}
          onOpenSession={onOpenSession}
          onClose={onClose}
        />
        {memberWindow.canLoadMore && (
          <button type="button" className="load-more mx-3 my-2" onClick={onLoadMore}>
            {t('team.chat.loadMoreMembers')}
          </button>
        )}
        {memberWindow.capped && (
          <p className="m-0 self-center font-mono text-xs text-faint" role="status">
            {t('team.chat.membersCapped', { shown: members.length, total: memberTotal })}
          </p>
        )}
      </aside>

      {narrow && membersOpen && (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label={t('team.a11y.closeMembers')}
          onClick={onCloseDrawer}
        />
      )}
    </>
  );
}
