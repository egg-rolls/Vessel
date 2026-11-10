import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { Button } from '../../components/ui';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import type { ErrorVisibility } from '../../state/error-visibility';
import type { RunGroup, StoredEvent, TimelineItem } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { ChatWelcome } from './ChatWelcome';
import { QueuedNotice, type QueuedSubmission, RunItems } from './StreamItems';
import { SubagentTranscript } from './SubagentTranscript';
import { Transcript } from './Transcript';
import type { TimelineLiveInput } from './timeline-order';
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
  transcriptStart,
  transcriptMessages,
  messageIndexOffset,
  detailNotice,
  onDismissDetailNotice,
  earlierError,
  onDismissEarlierError,
  onRetryEarlier,
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
  hasTranscript: boolean;
  /** 历史窗口之外还有更早的消息（滚到顶自动前插，不再有按钮 / 提示）。 */
  hasEarlier: boolean;
  visibleGroups: readonly RunGroup[];
  renderedGroups: readonly RunGroup[];
  visibleQueued: readonly QueuedSubmission[];
  transcriptWindow: { shown: Message[]; hiddenCount: number };
  transcriptStart: number;
  transcriptMessages: readonly Message[];
  /** `transcriptMessages[0]` 在完整 `state.messages` 里的绝对下标（撤回 / 重试用）。 */
  messageIndexOffset: number;
  /** 历史前缀被改写的一次性提示（i18n key）；null = 无。 */
  detailNotice: string | null;
  onDismissDetailNotice: () => void;
  /** 「加载更早」失败的原始细节；就地可关闭 notice + 重试，不用 toast。 */
  earlierError: string | null;
  onDismissEarlierError: () => void;
  onRetryEarlier: () => void;
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

  // hydrate 期间只挡「已经在历史里的组」：重放会先把已完成的 run 刷出来，detail 到达后
  // 再被 `isGroupPersisted` 收掉，看起来就是「闪现 + 跳跃」。
  // **正在跑的 run 永远渲染**：它是用户此刻唯一关心的内容；旧实现按「有没有排队项」
  // 整体隐藏 live，一旦排队项先消失，整段实时输出（工具卡 / 思考 / 正文）就被吞掉，
  // 表现就是「只看到自己的消息」。
  const hideReplayedLive = hydrating;

  // 实时节点（run 展开项 + 排队 notice）的**位置**由 timeline-order.ts 决定：
  // turn 锚点 / 窗口夹取 / 伪 run 拆条都是纯排序决策，统一放在那里
  // （可被 scripts/check-timeline-order.ts 机械判定）。这里只负责把数据翻译成入参、
  // 并给每个 key 准备渲染内容。
  const windowStartTs = transcriptWindow.shown[0]?.timestamp;

  /** 一条事件自身的 ts（notice / raw event 都带 event.ts）。 */
  const itemTs = (item: TimelineItem): number | undefined =>
    item.kind === 'notice' || item.kind === 'event' ? item.event.ts : undefined;

  /** 伪 run 组里一条 item 的独立渲染节点（各自按自己的 ts 落位）。 */
  const singleItemNode = (group: RunGroup, item: TimelineItem): ReactNode => (
    <RunItems
      group={{ ...group, items: [item], liveText: undefined, liveReasoning: undefined }}
      verbosity={verbosity}
    />
  );

  const liveInputs: TimelineLiveInput[] = [];
  const liveNodes = new Map<string, ReactNode>();

  if (!activeAgent) {
    for (const group of renderedGroups) {
      if (hideReplayedLive && group.status !== 'running') continue;
      if (group.hasRunEvent) {
        // 真实 run：整段作为一个节点（正文 / 思考 / 工具卡不可拆）。
        const runKey = 'run-' + group.runId;
        const runStartTs = group.startedAt ?? group.firstTs;
        liveInputs.push({
          key: runKey,
          ...(runStartTs !== undefined ? { startTs: runStartTs } : {}),
          ...(group.firstSeq !== undefined ? { seq: group.firstSeq } : {}),
          ...(group.input !== undefined ? { input: group.input } : {}),
          running: group.status === 'running',
        });
        liveNodes.set(
          runKey,
          <RunItems
            group={group}
            cancelled={cancelledJobs.has(group.runId)}
            hideInput={
              hasTranscript &&
              transcriptMessages.some(
                (message) => message.role === 'user' && message.content === group.input,
              )
            }
            verbosity={verbosity}
          />,
        );
        continue;
      }
      // 伪 run 组（run_id 是 runtime / session / 成员 id 等）：一条事件一个节点，
      // 各自按自己的事件时间落位；整组锚在首个事件上会让后续事件堆在最早时刻。
      const ambientKey = 'ambient-' + group.runId;
      liveInputs.push({
        key: ambientKey,
        ...(group.firstSeq !== undefined ? { seq: group.firstSeq } : {}),
        items: group.items.map((item, index) => {
          const ts = itemTs(item);
          return { key: index + '-' + item.key, ...(ts !== undefined ? { ts } : {}) };
        }),
      });
      group.items.forEach((item, index) => {
        liveNodes.set(ambientKey + '#' + index + '-' + item.key, singleItemNode(group, item));
      });
    }
    for (const item of visibleQueued) {
      const queuedKey = 'queued-' + item.runId;
      liveInputs.push({
        key: queuedKey,
        startTs: item.submittedAt,
        input: item.input,
        running: true,
      });
      liveNodes.set(queuedKey, <QueuedNotice item={item} onCancel={onCancelQueued} />);
    }
  }

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
          ) : hydrating && !hasTranscript && liveInputs.length === 0 ? (
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
          {hasTranscript || (!activeAgent && liveInputs.length > 0) ? (
            <Transcript
              messages={transcriptWindow.shown}
              allMessages={transcriptMessages}
              startIndex={transcriptStart}
              messageIndexOffset={messageIndexOffset}
              live={liveInputs}
              liveNodes={liveNodes}
              windowStartTs={windowStartTs}
              verbosity={verbosity}
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
