import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { Button } from '../../components/ui';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import type { ErrorVisibility } from '../../state/error-visibility';
import type { RunGroup, StoredEvent } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { ChatWelcome } from './ChatWelcome';
import { QueuedNotice, type QueuedSubmission, RunItems } from './StreamItems';
import { SubagentTranscript } from './SubagentTranscript';
import { Transcript } from './Transcript';
import { MAX_LIVE_GROUPS } from './useChatTranscript';
import { useStickyBottom } from './useStickyBottom';

/**
 * 会话滚动区：空态 / 错误态 / 历史消息 / 实时 run 与排队 notice / 子 agent。
 *
 * 吸附滚动见 `useStickyBottom`：打开/切会话等布局稳定后贴底；pinned 时跟随
 * 新内容（~100ms 节流、无 smooth）；用户上滚脱离；加载更早历史不触发贴底。
 */
export function TranscriptWindow({
  hasToken,
  selectedId,
  activeAgent,
  draftActive,
  restorePending,
  hydrateError,
  hydrating,
  hydrateStale,
  truncated,
  hasTranscript,
  visibleGroups,
  hiddenLiveGroups,
  renderedGroups,
  visibleQueued,
  transcriptWindow,
  transcriptStart,
  transcriptMessages,
  cancelledJobs,
  verbosity,
  errorLevel,
  entries,
  snapshotVersion,
  detailSessionId,
  onRetryDetail,
  onLoadEarlier,
  onCancelQueued,
  onConfigureConnection,
  onGoChat,
  onEditMessage,
  onRetryMessage,
}: {
  hasToken: boolean;
  selectedId: string | null;
  activeAgent: AgentNode | undefined;
  draftActive: boolean;
  restorePending: boolean;
  hydrateError: string | null;
  hydrating: boolean;
  hydrateStale: string | null;
  truncated: boolean;
  hasTranscript: boolean;
  visibleGroups: readonly RunGroup[];
  hiddenLiveGroups: number;
  renderedGroups: readonly RunGroup[];
  visibleQueued: readonly QueuedSubmission[];
  transcriptWindow: { shown: Message[]; hiddenCount: number };
  transcriptStart: number;
  transcriptMessages: readonly Message[];
  cancelledJobs: ReadonlySet<string>;
  verbosity: Verbosity;
  errorLevel: ErrorVisibility;
  entries: readonly StoredEvent[];
  snapshotVersion: number;
  detailSessionId: string | undefined;
  onRetryDetail: () => void;
  onLoadEarlier: () => void;
  onCancelQueued: (runId: string) => void;
  onConfigureConnection: () => void;
  onGoChat: () => void;
  onEditMessage: (text: string) => void;
  onRetryMessage: (text: string) => void;
}) {
  // 打开 / 切换会话的 reset key：detail 到达（hydrate）会再触发一次稳定贴底；
  // 加载更早历史不改变这两个字段，因此不会跳底。
  const resetKey = selectedId ? `${selectedId}:${detailSessionId ?? ''}` : null;
  const followKey = `${snapshotVersion}:${renderedGroups.length}:${visibleQueued.length}`;
  const { scrollRef, pinned, onScroll, scrollToBottom } = useStickyBottom({
    resetKey,
    followKey,
  });

  return (
    <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll}>
      {!hasToken ? (
        <EmptyState
          title={t('chat.empty.noConnectionTitle')}
          description={t('chat.empty.noConnectionDesc')}
          action={
            <Button type="button" variant="primary" onClick={onConfigureConnection}>
              {t('common.configureConnection')}
            </Button>
          }
        />
      ) : selectedId ? (
        <>
          {hydrateError ? (
            <ErrorState
              message={hydrateError === NOT_FOUND_MESSAGE ? t('chat.notFound') : hydrateError}
              onRetry={onRetryDetail}
              action={
                hydrateError === NOT_FOUND_MESSAGE ? (
                  <Button type="button" onClick={onGoChat}>
                    {t('breadcrumb.chat')}
                  </Button>
                ) : undefined
              }
            />
          ) : hydrating && !hasTranscript ? (
            <LoadingState label={t('chat.loadingHistory')} />
          ) : !hasTranscript &&
            visibleGroups.length === 0 &&
            visibleQueued.length === 0 &&
            !activeAgent ? (
            <EmptyState
              title={t('chat.empty.noHistoryTitle')}
              description={t('chat.empty.noHistoryDesc')}
            />
          ) : null}

          {hydrateStale && (
            <StaleNotice
              message={t('chat.staleHistory', { detail: hydrateStale })}
              onRetry={onRetryDetail}
            />
          )}

          {truncated && <StaleNotice message={t('chat.truncated')} />}

          {!activeAgent && hiddenLiveGroups > 0 && (
            <StaleNotice
              message={t('chat.run.hiddenEarlier', {
                shown: MAX_LIVE_GROUPS,
                hidden: hiddenLiveGroups,
              })}
            />
          )}

          {/* 0.18：历史消息与实时 run 的展开项共享同一个列表，没有 run 边界。 */}
          {hasTranscript ||
          (!activeAgent && (renderedGroups.length > 0 || visibleQueued.length > 0)) ? (
            <Transcript
              messages={transcriptWindow.shown}
              allMessages={transcriptMessages}
              startIndex={transcriptStart}
              hiddenCount={transcriptWindow.hiddenCount}
              onLoadEarlier={onLoadEarlier}
              onEditMessage={onEditMessage}
              onRetryMessage={onRetryMessage}
            >
              {!activeAgent &&
                renderedGroups.map((group) => (
                  <RunItems
                    key={group.runId}
                    group={group}
                    cancelled={cancelledJobs.has(group.runId)}
                    hideInput={
                      hasTranscript &&
                      transcriptMessages.some(
                        (message) => message.role === 'user' && message.content === group.input,
                      )
                    }
                    verbosity={verbosity}
                  />
                ))}
              {!activeAgent &&
                visibleQueued.map((item) => (
                  <QueuedNotice key={item.runId} item={item} onCancel={onCancelQueued} />
                ))}
            </Transcript>
          ) : null}

          {activeAgent && (
            <SubagentTranscript
              agent={activeAgent}
              entries={entries}
              errorLevel={errorLevel}
              verbosity={verbosity}
            />
          )}
        </>
      ) : draftActive ? (
        <ChatWelcome />
      ) : restorePending ? (
        <LoadingState label={t('chat.restoringSession')} />
      ) : null}
      {!pinned && (
        <button type="button" className="to-bottom" onClick={scrollToBottom}>
          {t('chat.toBottom')}
        </button>
      )}
    </div>
  );
}
