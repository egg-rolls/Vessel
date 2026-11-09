/**
 * Team 群聊容器：轮询 `teams.get` + 事件触发定向 reload + 乐观发送。
 *
 * - 权威消息源只有轮询；`run.*` / `agent.*` 事件只让 roster 与日志失效，
 *   不构造消息正文；
 * - 发送串行（无幂等键）：发送期间停轮询，成功后 reload 对账；
 * - 失败不自动重试；reload 找不到同内容消息才标 failed；
 * - “再次发送”只把内容填回 Composer，由用户再次确认后作为新日志。
 */
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t } from '../../i18n';
import { TeamChatHeader } from './TeamChatHeader';
import { TeamChatMain } from './TeamChatMain';
import { TeamMembersDialog } from './TeamMembersDialog';
import type { TeamChatProps } from './team-chat-types';
import { nextLimitFor, nextMembersLimitFor } from './team-window';
import { useTeamChat } from './useTeamChat';

export type { TeamChatClient, TeamChatProps } from './team-chat-types';

export function TeamChat(props: TeamChatProps) {
  // 页头 scope/status 槽来自路由层，不经 useTeamChat 派生。
  const { nodeName, nodeCurrent, frozen } = props;
  const {
    team,
    teamId,
    archived,
    members,
    memberTotal,

    membersOpen,
    setMembersOpen,
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
    editMessage,
    resendMessage,
    requestRetract,
    cancelRetract,
    confirmRetract,
    retractTarget,
    retracting,
    retractError,
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
        nodeName={nodeName}
        nodeCurrent={nodeCurrent}
        frozen={frozen}
        memberTotal={memberTotal}
        onOpenMembers={() => setMembersOpen(true)}
        onBackToList={onBackToList}
        onRefresh={reload}
        hasToken={hasToken}
        refreshing={refreshing}
      />

      <div className="team-chat-body">
        <TeamChatMain
          teamId={teamId}
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
          onEditMessage={editMessage}
          onResendMessage={resendMessage}
          onRetractMessage={requestRetract}
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
      </div>

      {membersOpen && (
        <TeamMembersDialog
          members={members}
          memberTotal={memberTotal}
          permissions={permissions}
          asks={asks}
          memberWindow={memberWindow}
          loading={firstLoading}
          onOpenMember={openMember}
          onOpenSession={(sessionId) => {
            setMembersOpen(false);
            onOpenSession(sessionId);
          }}
          onLoadMore={() => setMembersLimit(nextMembersLimitFor(membersLimit))}
          onClose={() => setMembersOpen(false)}
        />
      )}

      {retractTarget && (
        <ConfirmDialog
          title={t('team.message.retractTitle')}
          body={<p>{t('team.message.retractBody')}</p>}
          confirmLabel={t('team.message.retractConfirm')}
          danger
          busy={retracting}
          onConfirm={() => {
            void confirmRetract();
          }}
          onCancel={cancelRetract}
          extra={
            retractError ? (
              <p className="text-xs text-danger leading-snug" role="alert">
                {retractError}
              </p>
            ) : undefined
          }
        />
      )}
    </section>
  );
}
