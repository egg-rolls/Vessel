/**
 * Team 成员侧栏容器（右侧常驻列 / ≤1023px 固定抽屉）。
 *
 * - ≥1024px：`.team-chat-body` 的 grid 第二列（`--team-members-w`）；
 * - ≤1023px：同一节点变固定抽屉，靠 `.open` + 遮罩 + inert/aria-hidden
 *   表达开关，Esc 由 `useDrawerA11y` 处理；
 * - 顶部 SearchInput 复用旧成员弹层的过滤口径（name / agent_id / role），
 *   `useLocale()` 订阅语言切换，角色名切换语言后立即重新过滤；
 * - 数量口径：不过滤时侧栏头部是「当前窗口 / member_total」；过滤时头部只传
 *   `filtered.length`（读作「匹配 / 匹配」），另起一行给事实
 *   `team.members.matches`：「匹配 matched / 已加载 loaded（当前窗口长度）」。
 *   不拿匹配数去比 `member_total`，避免「3 / 240」被读成「只展示了 240 中的 3 个」。
 * - 焦点取舍：抽屉关闭时 `useDrawerA11y` 拿不到固定 id，改为**恢复打开前的
 *   `document.activeElement`**（通常是卡片/菜单触发按钮）；若该节点已随菜单收起
 *   卸载，焦点才落到 `document.body`。
 */
import type { RefObject } from 'react';
import { useState } from 'react';
import { EmptyState, LoadingState } from '../../components/States';
import { SearchInput } from '../../components/ui';
import type { AskUserRequest, PermissionRequest, TeamMember } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { shortAgentId } from './mention';
import { roleLabelKey, roleOf } from './role';
import { TeamMemberSidebar } from './TeamMemberSidebar';
import type { MemberWindowFlags } from './team-window';

export interface TeamChatMembersAsideProps {
  members: readonly TeamMember[];
  memberTotal: number;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** 抽屉里的 × 按钮；常驻列传 `undefined` 不渲染。 */
  onClose: (() => void) | undefined;
  membersOpen: boolean;
  narrow: boolean;
  drawerRef: RefObject<HTMLElement | null>;
  memberWindow: MemberWindowFlags;
  /** `useTeamChat` 的首次加载态：首屏没拿到 roster 时不显示「无匹配」。 */
  loading: boolean;
  onLoadMore: () => void;
  onCloseDrawer: () => void;
}

/** 名字 / agent_id / 角色（含本地化角色名）匹配，与旧成员弹层一致。 */
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
  loading,
  onLoadMore,
  onCloseDrawer,
}: TeamChatMembersAsideProps) {
  // 订阅 locale：切换语言时角色过滤结果随之更新。
  useLocale();
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? members.filter((member) => matchesMember(member, normalized))
    : members;

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
        <div className="px-2 pb-2">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('team.members.search')}
            ariaLabel={t('team.members.search')}
          />
        </div>
        {normalized !== '' && (
          // 「匹配 / 已加载」：loaded 取当前 roster 窗口长度，不去比 team.member_count，
          // 被 capped 时另有 team.chat.membersCapped 提示。
          <p className="mx-2 mt-0 mb-2 font-mono text-2xs text-faint" role="status">
            {t('team.members.matches', { matched: filtered.length, total: members.length })}
          </p>
        )}
        {loading ? (
          <LoadingState rows={4} />
        ) : filtered.length === 0 ? (
          <EmptyState title={t('team.members.empty')} />
        ) : (
          // 包一层 flex-1：侧栏本体用 h-full，需要确定的父高度才能让列表内部滚动
          // （SearchInput 占据上方空间后，直接 h-full 会溢出列高）。
          <div className="flex min-h-0 flex-1 flex-col">
            <TeamMemberSidebar
              members={filtered}
              // 计数口径：过滤时 total 与 members 同值（头部「匹配 / 匹配」），
              // 不过滤时才用 member_total（「窗口 / 总数」），两者都不谎报。
              total={normalized ? filtered.length : memberTotal}
              permissions={permissions}
              asks={asks}
              onOpenMember={onOpenMember}
              onOpenSession={onOpenSession}
              onClose={onClose}
            />
          </div>
        )}
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
