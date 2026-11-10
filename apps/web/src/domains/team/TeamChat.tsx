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
import { ResizeHandle } from '../../components/ResizeHandle';
import { t } from '../../i18n';
import { TeamChatHeader } from './TeamChatHeader';
import { TeamChatMain } from './TeamChatMain';
import { TeamChatMembersAside } from './TeamChatMembersAside';
import type { TeamChatProps } from './team-chat-types';
import { nextMembersLimitFor } from './team-window';
import { useTeamChat } from './useTeamChat';

export type { TeamChatClient, TeamChatProps } from './team-chat-types';

export function TeamChat(props: TeamChatProps) {
  // 页头 scope/status 槽来自路由层，不经 useTeamChat 派生。
  const { nodeName, nodeCurrent, frozen } = props;
  // 成员栏开关由 useTeamsView 持有（入口在 Team 卡 ActionMenu）；这里只读。
  const { membersOpen, onCloseMembers, panes } = props;
  const {
    team,
    teamId,
    archived,
    members,
    memberTotal,

    narrow,
    membersDrawerRef,
    detail,
    error,
    firstLoading,
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
    hasEarlier,
    loadEarlier,
    earlierLoading,
    historyNotice,
    dismissHistoryNotice,
    historyReloadToken,
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
        onBackToList={onBackToList}
      />

      <div className={`team-chat-body ${membersOpen ? 'has-members' : ''}`.trim()}>
        {/* 内容列宽度手柄：与会话页同一个 `chat` pane（共用 --chat-content-w）。
            ≤1023 内容列退化成满宽，`narrow` 与 CSS 媒体查询双保险隐藏。 */}
        {!narrow && !panes.disabled('chat') && (
          <ResizeHandle
            pane="chat"
            api={panes}
            label={t('resize.chat')}
            className="resize-handle resize-handle-team-chat"
          />
        )}
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
          hasEarlier={hasEarlier}
          loadingEarlier={earlierLoading}
          onLoadEarlier={loadEarlier}
          historyNotice={historyNotice}
          onDismissHistoryNotice={dismissHistoryNotice}
          historyReloadToken={historyReloadToken}
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
        {/* 常驻右列（grid 第二列）；≤1023px 同一节点是固定抽屉，
            关闭时仍需挂载以保留 `.open` 过渡与 inert/aria-hidden 语义。 */}
        {(membersOpen || narrow) && (
          <TeamChatMembersAside
            members={members}
            memberTotal={memberTotal}
            permissions={permissions}
            asks={asks}
            memberWindow={memberWindow}
            loading={firstLoading}
            membersOpen={membersOpen}
            narrow={narrow}
            drawerRef={membersDrawerRef}
            onOpenMember={openMember}
            onOpenSession={(sessionId) => {
              // 窄屏抽屉在跳走前先收起，避免返回 Team 时抽屉仍开着。
              if (narrow) onCloseMembers();
              onOpenSession(sessionId);
            }}
            onLoadMore={() => setMembersLimit(nextMembersLimitFor(membersLimit))}
            onClose={narrow ? onCloseMembers : undefined}
            onCloseDrawer={onCloseMembers}
          />
        )}
      </div>

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
