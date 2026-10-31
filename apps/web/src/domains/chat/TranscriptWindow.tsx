import { useCallback, useEffect, useRef, useState } from 'react';
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

const SCROLL_FOLLOW_MS = 100;

/**
 * 会话滚动区：空态 / 错误态 / 历史消息 / 实时 run 与排队 notice / 子 agent。
 *
 * 滚动跟随也在本组件内：贴近底部时随流式追加滚动，50ms 合批下再节流到 ~100ms，
 * 且不用 smooth scroll（流式 token 期间连续 smooth 会堆积动画）；切换会话后直接贴底。
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
}) {
  const [nearBottom, setNearBottom] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const followTimer = useRef<number | undefined>(undefined);
  const lastFollowAt = useRef(0);

  // 接近底部时跟随新事件；50ms 合批下再节流到 ~100ms，且不用 smooth scroll
  // （流式 token 期间连续 smooth 会堆积动画）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot.version 是流式追加的显式触发器
  useEffect(() => {
    if (renderedGroups.length === 0 && visibleQueued.length === 0) return;
    if (!nearBottomRef.current) return;
    const nowMs = Date.now();
    const remaining = SCROLL_FOLLOW_MS - (nowMs - lastFollowAt.current);
    if (remaining <= 0) {
      lastFollowAt.current = nowMs;
      window.clearTimeout(followTimer.current);
      followTimer.current = undefined;
      bottomRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    if (followTimer.current !== undefined) return;
    followTimer.current = window.setTimeout(() => {
      followTimer.current = undefined;
      if (!nearBottomRef.current) return;
      lastFollowAt.current = Date.now();
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }, remaining);
  }, [snapshotVersion, renderedGroups.length, visibleQueued.length]);

  // 切换会话/历史加载完成后直接展示最新内容。
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId/detail 变化时跳到底部
  useEffect(() => {
    if (!selectedId) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedId, detailSessionId]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance < 96;
    nearBottomRef.current = near;
    setNearBottom(near);
  }, []);

  // dock 增高 / 缩短（卡牌出现、切题、输入框变高）会改变滚动容器的高度：
  // 用户原本贴底时保持贴底；已离开底部则不抢滚动位置。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(element);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(followTimer.current);
    },
    [],
  );

  const scrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  return (
    <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
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
              startIndex={transcriptStart}
              hiddenCount={transcriptWindow.hiddenCount}
              onLoadEarlier={onLoadEarlier}
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
      <div ref={bottomRef} />
      {!nearBottom && (
        <button type="button" className="to-bottom" onClick={scrollToBottom}>
          {t('chat.toBottom')}
        </button>
      )}
    </div>
  );
}
