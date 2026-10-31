/**
 * Team 群聊容器：轮询 `teams.get` + 事件触发定向 reload + 乐观发送。
 *
 * - 权威消息源只有轮询；`run.*` / `agent.*` 事件只让 roster 与日志失效，
 *   不构造消息正文；
 * - 发送串行（无幂等键）：发送期间停轮询，成功后 reload 对账；
 * - 失败不自动重试；reload 找不到同内容消息才标 failed；
 * - “再次发送”只把内容填回 Composer，由用户再次确认后作为新日志。
 */
import { TeamChatHeader } from './TeamChatHeader';
import { TeamChatMain } from './TeamChatMain';
import { TeamChatMembersAside } from './TeamChatMembersAside';
import type { TeamChatProps } from './team-chat-types';
import { nextLimitFor, nextMembersLimitFor } from './team-window';
import { useTeamChat } from './useTeamChat';

export type { TeamChatClient, TeamChatProps } from './team-chat-types';

export function TeamChat(props: TeamChatProps) {
  const {
    team,
    teamId,
    archived,
    members,
    memberTotal,
    onlineCount,
    membersOpen,
    setMembersOpen,
    narrow,
    membersDrawerRef,
    detail,
    error,
    firstLoading,
    refreshing,
    rotateFailure,
    rows,
    resolveMember,
    agentLabel,
    draft,
    setDraft,
    chips,
    setChips,
    retryHint,
    setRetryHint,
    sending,
    handleSend,
    handleRetry,
    reload,
    hasToken,
    canLoadEarlier,
    historyLimited,
    visibleCount,
    limit,
    setLimit,
    memberWindow,
    membersLimit,
    setMembersLimit,
    permissions,
    asks,
    responding,
    connected,
    onDecidePermission,
    onRespondAsk,
    onOpenSession,
    onBackToList,
    openMember,
  } = useTeamChat(props);

  const onComposerChange = (value: string) => {
    setDraft(value);
    if (retryHint) setRetryHint(false);
  };

  return (
    <section className="team-chat" aria-label={team?.name ?? teamId}>
      <TeamChatHeader
        team={team}
        teamId={teamId}
        archived={archived}
        membersShown={members.length}
        memberTotal={memberTotal}
        onlineCount={onlineCount}
        membersOpen={membersOpen}
        onToggleMembers={() => setMembersOpen((value) => !value)}
        onBackToList={onBackToList}
        onRefresh={reload}
        hasToken={hasToken}
        refreshing={refreshing}
      />

      <div className="team-chat-body">
        <TeamChatMain
          detail={detail}
          error={error}
          hasToken={hasToken}
          firstLoading={firstLoading}
          rows={rows}
          rotateFailure={rotateFailure}
          resolveMember={resolveMember}
          agentLabel={agentLabel}
          onOpenSession={onOpenSession}
          onRetrySend={handleRetry}
          onRefresh={reload}
          canLoadEarlier={canLoadEarlier}
          historyLimited={historyLimited}
          visibleCount={visibleCount}
          limit={limit}
          onLoadEarlier={() => setLimit(nextLimitFor(limit))}
          members={members}
          permissions={permissions}
          asks={asks}
          responding={responding}
          connected={connected}
          onDecidePermission={onDecidePermission}
          onRespondAsk={onRespondAsk}
          draft={draft}
          onDraftChange={onComposerChange}
          chips={chips}
          onChipsChange={setChips}
          onSend={() => void handleSend()}
          sending={sending}
          archived={archived}
          targetLabel={team?.name ?? teamId}
          retryHint={retryHint}
        />

        <TeamChatMembersAside
          members={members}
          memberTotal={memberTotal}
          permissions={permissions}
          asks={asks}
          onOpenMember={openMember}
          onOpenSession={onOpenSession}
          onClose={narrow ? () => setMembersOpen(false) : undefined}
          membersOpen={membersOpen}
          narrow={narrow}
          drawerRef={membersDrawerRef}
          memberWindow={memberWindow}
          onLoadMore={() => setMembersLimit(nextMembersLimitFor(membersLimit))}
          onCloseDrawer={() => setMembersOpen(false)}
        />
      </div>
    </section>
  );
}
