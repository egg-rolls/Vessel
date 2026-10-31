import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { cn } from '../../components/ui';
import type {
  AskUserRequest,
  PermissionRequest,
  TeamDetail,
  TeamMember,
  TeamMessage,
} from '../../gateway/types';
import { t } from '../../i18n';
import type { RotateFailureView } from '../../state/teams';
import type { MentionChip } from './mention';
import { TeamComposer } from './TeamComposer';
import type { TeamMessageView } from './TeamMessageRow';
import { TeamPendingBar } from './TeamPendingBar';
import { TeamTranscript } from './TeamTranscript';
import type { TeamChatDecidePermission, TeamChatRespondAsk } from './team-chat-types';

export interface TeamChatMainProps {
  detail: TeamDetail | undefined;
  error: { message: string; code?: string } | undefined;
  hasToken: boolean;
  firstLoading: boolean;
  rows: readonly TeamMessageView[];
  rotateFailure: RotateFailureView | null;
  resolveMember: (agentId: string) => TeamMember | undefined;
  agentLabel: (agentId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onRetrySend: (message: TeamMessage) => void;
  onRefresh: () => void;
  canLoadEarlier: boolean;
  historyLimited: boolean;
  visibleCount: number;
  limit: number;
  onLoadEarlier: () => void;
  members: readonly TeamMember[];
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  responding: ReadonlySet<string>;
  connected: boolean;
  onDecidePermission?: TeamChatDecidePermission;
  onRespondAsk?: TeamChatRespondAsk;
  draft: string;
  onDraftChange: (value: string) => void;
  chips: readonly MentionChip[];
  onChipsChange: (chips: MentionChip[]) => void;
  onSend: () => void;
  sending: boolean;
  archived: boolean;
  targetLabel: string;
  retryHint: boolean;
}

export function TeamChatMain({
  detail,
  error,
  hasToken,
  firstLoading,
  rows,
  rotateFailure,
  resolveMember,
  agentLabel,
  onOpenSession,
  onRetrySend,
  onRefresh,
  canLoadEarlier,
  historyLimited,
  visibleCount,
  limit,
  onLoadEarlier,
  members,
  permissions,
  asks,
  responding,
  connected,
  onDecidePermission,
  onRespondAsk,
  draft,
  onDraftChange,
  chips,
  onChipsChange,
  onSend,
  sending,
  archived,
  targetLabel,
  retryHint,
}: TeamChatMainProps) {
  return (
    <div className="team-chat-main">
      {detail && error && <StaleNotice message={t('team.error.stale')} onRetry={onRefresh} />}
      <div className="team-transcript-scroll">
        {rotateFailure && (
          <div
            className={cn(
              'team-notice-danger mx-auto my-0.5 max-w-180 rounded-r-sm border-l-2 border-l-line-strong bg-sunken px-3 py-1.25 text-center text-sm text-muted',
              'border-l-danger bg-danger-soft text-ink',
            )}
            role="alert"
          >
            <span className="mr-1.5 font-mono text-2xs uppercase text-faint">
              {t('team.message.systemTag')}
            </span>
            <span>
              {t('team.system.rotateFailed', {
                name: rotateFailure.agent_id
                  ? agentLabel(rotateFailure.agent_id)
                  : t('team.system.unknown'),
              })}
            </span>
            {(rotateFailure.reason ?? rotateFailure.code) && (
              <span className="font-mono"> {rotateFailure.reason ?? rotateFailure.code}</span>
            )}
          </div>
        )}
        {!hasToken ? (
          <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
        ) : firstLoading ? (
          <LoadingState rows={3} />
        ) : !detail ? (
          error?.code === 'not_found' ? (
            <NotEnabledState
              title={t('team.error.notEnabled')}
              reason={t('team.error.notEnabledReason')}
              hint={t('team.error.notEnabledHint')}
            />
          ) : (
            <ErrorState
              message={error?.message ?? t('team.error.loadFailed')}
              onRetry={onRefresh}
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState title={t('team.chat.empty')} description={t('team.chat.emptyHint')} />
        ) : (
          <TeamTranscript
            messages={rows}
            resolveMember={resolveMember}
            resolveMemberLabel={agentLabel}
            onViewMemberSession={(_agentId, sessionId) => onOpenSession(sessionId)}
            onRetrySend={onRetrySend}
          />
        )}

        {canLoadEarlier && (
          <button type="button" className="load-earlier self-center" onClick={onLoadEarlier}>
            {t('team.chat.loadEarlier')}
          </button>
        )}
        {detail && historyLimited && (
          <p className="m-0 self-center font-mono text-xs text-faint" role="status">
            {t('team.chat.historyLimited', { count: visibleCount, limit })}
          </p>
        )}
      </div>

      <div className="team-composer-area">
        <TeamPendingBar
          members={members}
          permissions={permissions}
          asks={asks}
          responding={responding}
          connected={connected}
          onDecidePermission={onDecidePermission}
          onRespondAsk={onRespondAsk}
        />
        <TeamComposer
          value={draft}
          onChange={onDraftChange}
          mentions={chips}
          onMentionsChange={onChipsChange}
          onSend={onSend}
          sending={sending}
          hasToken={hasToken}
          connected={connected && !archived}
          disabled={archived}
          members={members}
          targetLabel={targetLabel}
          retryHint={retryHint}
        />
      </div>
    </div>
  );
}
