import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Markdown } from '../../components/Markdown';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { Button } from '../../components/ui';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import type { ErrorVisibility } from '../../state/error-visibility';
import type { RunGroup, StoredEvent } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { AgentMessageCard } from './AgentMessageCard';
import { ChatWelcome } from './ChatWelcome';
import { NoticeRow } from './EventRow';
import { ReasoningBlock } from './ReasoningBlock';
import { StreamCard } from './StreamCard';
import { QueuedNotice, type QueuedSubmission, UserBubble } from './StreamItems';
import { SubagentTranscript } from './SubagentTranscript';
import { ToolCard } from './ToolCard';
import { Transcript } from './Transcript';
import { buildTranscriptItems, type HistoryIndex, type TranscriptItem } from './transcript-items';
import { useStickyBottom } from './useStickyBottom';

/** 距顶多少像素内触发前插一页。 */
const EARLIER_TRIGGER_PX = 200;
/** 一页填不满视口时的连续补页上限（避免短会话无限请求）。 */
const AUTO_PAGE_BUDGET = 20;

/**
 * 会话滚动区：空态 / 错误态 / 历史消息 / 实时 run 与排队 notice / 子 agent。
 *
 * 吸附滚动见 `useStickyBottom`：打开/切会话等布局稳定后贴底；pinned 时跟随
 * 新内容（~100ms 节流、无 smooth）；用户上滚脱离；加载更早历史不触发贴底。
 *
 * 历史分页是**无感**的：没有「加载更早」按钮，也没有「仅显示最近 N 条」提示；
 * 滚到顶部阈值内自动前插一页，并用 `scrollHeight` 差值回填 `scrollTop` 保住视觉锚点。
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
  hasTranscript,
  hasEarlier,
  visibleGroups,
  renderedGroups,
  visibleQueued,
  transcriptWindow,
  transcriptMessages,
  historyIndex,
  isHiddenMessage,
  noticeKindOf,
  messageIndexOffset,
  detailNotice,
  onDismissDetailNotice,
  earlierError,
  onDismissEarlierError,
  onRetryEarlier,
  verbosity,
  cardsDefaultOpen,
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
  hasTranscript: boolean;
  /** 历史窗口之外还有更早的消息（滚到顶自动前插，不再有按钮 / 提示）。 */
  hasEarlier: boolean;
  visibleGroups: readonly RunGroup[];
  renderedGroups: readonly RunGroup[];
  visibleQueued: readonly QueuedSubmission[];
  transcriptWindow: { shown: Message[]; hiddenCount: number };
  transcriptMessages: readonly Message[];
  /** 历史侧 item / 反查表（调用侧按 messages 引用 memo，见 useChatTranscript）。 */
  historyIndex: HistoryIndex;
  /** runtime 上下文可见性判定（隐藏的消息不产 item，但仍参与下标与认领）。 */
  isHiddenMessage: (message: Message) => boolean;
  /** 运行时提示卡的分类（vessel:* 种类；undefined = 普通消息）。 */
  noticeKindOf: (message: Message) => string | undefined;
  /** `transcriptMessages[0]` 在完整 `state.messages` 里的绝对下标（撤回 / 重试用）。 */
  messageIndexOffset: number;
  /** 历史前缀被改写的一次性提示（i18n key）；null = 无。 */
  detailNotice: string | null;
  onDismissDetailNotice: () => void;
  /** 「加载更早」失败的原始细节；就地可关闭 notice + 重试，不用 toast。 */
  earlierError: string | null;
  onDismissEarlierError: () => void;
  onRetryEarlier: () => void;
  verbosity: Verbosity;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  cardsDefaultOpen: boolean;
  errorLevel: ErrorVisibility;
  entries: readonly StoredEvent[];
  snapshotVersion: number;
  detailSessionId: string | undefined;
  onRetryDetail: () => void;
  onLoadEarlier: () => void;
  onCancelQueued: (runId: string) => void;
  onConfigureConnection: () => void;
  onGoChat: () => void;
  onEditMessage: (keepMessages: number, text: string) => void;
  onRetryMessage: (keepMessages: number, text: string) => void;
}) {
  // 打开 / 切换会话的 reset key：detail 到达（hydrate）会再触发一次稳定贴底；
  // 加载更早历史不改变这两个字段，因此不会跳底。
  const resetKey = selectedId ? `${selectedId}:${detailSessionId ?? ''}` : null;
  const followKey = `${snapshotVersion}:${renderedGroups.length}:${visibleQueued.length}`;
  const { scrollRef, getElement, pinned, onScroll, scrollToBottom, userIntentProps } =
    useStickyBottom({
      resetKey,
      followKey,
    });

  // 前插锚点：请求前记录 (scrollHeight, scrollTop)，布局落地后按高度差回填 scrollTop。
  // 这样历史消息只会在视口上方长出来，用户看到的行不移动；stickyBottom 的 pinned
  // 不受影响（程序化回填不改变 followKey / resetKey，且内容高度变化不算用户上滚）。
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  /** 锚点兜底计时器：没有产生新分页时不要让锚点卡住后续请求。 */
  const anchorTimerRef = useRef<number | undefined>(undefined);
  /** 连续自动补页的次数，防止「一页填不满视口」时无限请求。 */
  const autoPagesRef = useRef(0);

  const requestEarlier = useCallback(() => {
    if (!hasEarlier || anchorRef.current !== null) return;
    const element = getElement();
    if (!element) return;
    const anchor = { height: element.scrollHeight, top: element.scrollTop };
    anchorRef.current = anchor;
    window.clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = window.setTimeout(() => {
      // 没有新消息落地（请求失败 / detail 恰好没变化）时释放锚点，避免永久卡住。
      // 3000ms 覆盖「加载更早」的服务端往返；本地扩窗仍在下一帧立即回填。
      if (anchorRef.current === anchor) anchorRef.current = null;
    }, 3000);
    onLoadEarlier();
  }, [hasEarlier, getElement, onLoadEarlier]);

  // 布局阶段回填：前插内容在上方长高多少，就把 scrollTop 推高多少。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 分页长度是回填的显式触发器
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    anchorRef.current = null;
    window.clearTimeout(anchorTimerRef.current);
    const element = getElement();
    if (!element) return;
    const grown = element.scrollHeight - anchor.height;
    element.scrollTop = anchor.top + Math.max(0, grown);
    autoPagesRef.current += 1;
    // 一页还没填满视口（没有滚动条）且还有更早的分页：继续补，直到出现滚动条或没有更多。
    if (
      autoPagesRef.current < AUTO_PAGE_BUDGET &&
      element.scrollHeight <= element.clientHeight + 1
    ) {
      requestEarlier();
    }
  }, [transcriptWindow.shown.length, getElement, requestEarlier]);

  // 可见窗口首条消息的 ts：比它更早的 live item 由 buildTranscriptItems 夹到末尾
  // （turn 锚点 / 窗口夹取 / 伪 run 拆条都在那里，由 check-timeline-order + 本模块门禁守）。
  const windowStartTs = transcriptWindow.shown[0]?.timestamp;

  // 单一 item 流：历史消息、live 事件、排队提交先合成 item，再按 kind 选组件渲染。
  // 身份 / 去重 / 排序都在 transcript-items.ts（纯函数 + 门禁），这里只做渲染映射。
  const items = useMemo(
    () =>
      buildTranscriptItems({
        messages: transcriptMessages,
        messageIndexOffset,
        liveGroups: activeAgent ? [] : renderedGroups,
        queued: visibleQueued,
        windowStartTs,
        historyIndex,
        isHidden: isHiddenMessage,
        noticeKindOf,
      }),
    [
      transcriptMessages,
      messageIndexOffset,
      activeAgent,
      renderedGroups,
      visibleQueued,
      windowStartTs,
      historyIndex,
      isHiddenMessage,
      noticeKindOf,
    ],
  );

  const renderItem = (item: TranscriptItem): ReactNode => {
    switch (item.kind) {
      case 'run-input':
        // 身份在 item 建好时就定了（`sender` 来自 run.started.input_name / user.message.name）：
        // agent 投递直接用同一张 AgentMessageCard，不会先出一帧用户气泡。
        return item.sender !== undefined ? (
          <AgentMessageCard
            sender={item.sender}
            content={item.text}
            ts={item.ts}
            defaultOpen={cardsDefaultOpen}
          />
        ) : (
          <UserBubble text={item.text} ts={item.ts} />
        );
      case 'run-text':
        return item.streaming ? (
          <div className="msg-assistant max-w-full">
            <div className="msg-text live-text">{item.text}</div>
          </div>
        ) : (
          <div className="msg-assistant group max-w-full">
            <Markdown className="msg-text" text={item.text} />
          </div>
        );
      case 'run-reasoning':
        return (
          <ReasoningBlock
            text={item.text}
            streaming={item.streaming}
            startedAt={item.startedAt}
            endedAt={item.endedAt}
          />
        );
      case 'tool':
        return (
          <ToolCard
            card={{
              kind: 'tool',
              key: item.key,
              ...(item.callId !== undefined ? { callId: item.callId } : {}),
              name: item.name,
              status: item.status,
              ...(item.args !== undefined ? { args: item.args } : {}),
              ...(item.output !== undefined ? { result: item.output } : {}),
              ...(item.error !== undefined ? { error: item.error } : {}),
              ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
              ...(item.truncated === true ? { truncated: true } : {}),
              startedAt: item.startedAt,
            }}
            verbosity={verbosity}
            defaultOpen={cardsDefaultOpen}
          />
        );
      case 'notice':
        return <NoticeRow event={item.event} defaultOpen={cardsDefaultOpen} />;
      case 'runtime-notice':
        // 运行时提示（vessel:notice / source / 裸 [inbox]…）：notice 卡，不是用户气泡。
        return (
          <StreamCard
            className="runtime-notice-card w-full min-w-0 max-w-full"
            tone="info"
            defaultOpen={cardsDefaultOpen}
            title={
              <span className="font-mono text-2xs tracking-wider text-accent">
                {t('chat.notice.runtime', { kind: item.noticeKind })}
              </span>
            }
            summary={item.text}
          >
            <p className="m-0 min-w-0 px-2.5 pb-2 break-words whitespace-pre-wrap wrap-anywhere text-sm text-muted">
              {item.text}
            </p>
          </StreamCard>
        );
      case 'queued':
        return (
          <QueuedNotice
            item={{
              runId: item.runId,
              input: item.input,
              ...(item.queuePosition !== undefined ? { queuePosition: item.queuePosition } : {}),
              submittedAt: item.submittedAt,
              cancelling: item.cancelling,
              cancelled: item.cancelled,
            }}
            onCancel={onCancelQueued}
            defaultOpen={cardsDefaultOpen}
          />
        );
      default:
        return null;
    }
  };

  // 滚到顶部阈值内自动前插一页。用户手势产生的 scroll 才会触发，程序化回填不会
  // （回填把 scrollTop 推高，远离阈值）。
  const handleScroll = useCallback(() => {
    onScroll();
    const element = getElement();
    if (element && element.scrollTop <= EARLIER_TRIGGER_PX) requestEarlier();
  }, [onScroll, getElement, requestEarlier]);

  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={handleScroll}
      {...userIntentProps}
    >
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
          ) : hydrating && !hasTranscript && items.length === 0 ? (
            // 只有「什么都没有」时才换成 LoadingState：重连 / 重订阅时实时内容还在，
            // 换屏本身就是一次闪烁。
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

          {detailNotice && (
            <StaleNotice message={t(detailNotice)} onDismiss={onDismissDetailNotice} />
          )}

          {/* 历史加载失败：就地可关闭 + 重试（历史加载是就地动作，弹 toast 会丢锚点）。
              文案框架本地化，原始细节放在 detail 里，不把英文错误直接当正文。 */}
          {earlierError && (
            <StaleNotice
              message={t('chat.earlierLoadFailed', { detail: earlierError })}
              onRetry={onRetryEarlier}
              onDismiss={onDismissEarlierError}
            />
          )}

          {/* 0.18：历史消息与实时 run 的展开项共享同一个列表，没有 run 边界；
              0.50：实时节点按 run 起始时间插进历史消息之间，不再整块追加在末尾。
              hydrate 期间先只给 LoadingState：重放会先灌进来一批准 live 组，
              详情到达后再被 `isGroupPersisted` 收掉，看起来就是「闪现 + 跳跃」。 */}
          {items.length > 0 ? (
            <Transcript
              items={items}
              allMessages={transcriptMessages}
              messageIndexOffset={messageIndexOffset}
              cardsDefaultOpen={cardsDefaultOpen}
              renderItem={renderItem}
              onEditMessage={onEditMessage}
              onRetryMessage={onRetryMessage}
            />
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
