import { useCallback, useLayoutEffect, useRef } from 'react';
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
import { Transcript, type TranscriptLiveEntry } from './Transcript';
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

  // 实时节点（run 展开项 + 排队 notice）按自身起始时间插进历史消息之间；
  // 排序与日分组在 `Transcript` 内完成，这里只给出时间戳（+ 同刻回退用的 seq）与节点。
  // 比历史窗口还早的节点（窗口外的失败 / 取消 run）不给时间戳：`Transcript` 会把它
  // 排在末尾，避免一张陈旧 run 卡黏在窗口顶部第一条可见消息上面。
  const windowStartTs = transcriptWindow.shown[0]?.timestamp;
  const sortTs = (ts: number | undefined): number | undefined =>
    ts === undefined || windowStartTs === undefined || ts >= windowStartTs ? ts : undefined;

  /** 一条事件自身的 ts（notice / raw event 都带 `event.ts`）。 */
  const itemTs = (item: TimelineItem): number | undefined =>
    item.kind === 'notice' || item.kind === 'event' ? item.event.ts : undefined;

  /** 把一条 item 拆成独立渲染节点：环境事件按自己的 ts 落位，不跟着整组走。 */
  const singleItemEntry = (group: RunGroup, item: TimelineItem): TranscriptLiveEntry => ({
    key: `${group.runId}-${item.key}`,
    ts: sortTs(itemTs(item)),
    seq: group.firstSeq,
    node: (
      <RunItems
        group={{ ...group, items: [item], liveText: undefined, liveReasoning: undefined }}
        verbosity={verbosity}
      />
    ),
  });

  const liveEntries: TranscriptLiveEntry[] = activeAgent
    ? []
    : [
        ...renderedGroups
          .filter((group) => !(hideReplayedLive && group.status !== 'running'))
          .flatMap((group): TranscriptLiveEntry[] => {
            // 真实 run（`hasRunEvent`）：整段作为一个节点，按 run 起始时间定位 ——
            // 同一个 run 的正文 / 思考 / 工具卡必须连在一起，不能被拆散重排。
            if (group.hasRunEvent) {
              return [
                {
                  key: `run-${group.runId}`,
                  ts: sortTs(group.startedAt ?? group.firstTs),
                  seq: group.firstSeq,
                  node: (
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
                    />
                  ),
                },
              ];
            }
            // 环境事件（`run_id` 是 `runtime` / `session` / 成员 id 等伪 run）：一条事件
            // 一个节点。它们会持续往同一个伪 run 里追加，整组只按「首次出现」定位时，
            // 后续事件会永远停在那一个时间点——正是用户看到的「系统事件聚堆、不按时间」。
            return group.items.map((item) => singleItemEntry(group, item));
          }),
        ...visibleQueued.map((item) => ({
          key: `queued-${item.runId}`,
          ts: sortTs(item.submittedAt),
          node: <QueuedNotice item={item} onCancel={onCancelQueued} />,
        })),
      ];

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
          {hasTranscript || (!activeAgent && liveEntries.length > 0) ? (
            <Transcript
              messages={transcriptWindow.shown}
              allMessages={transcriptMessages}
              startIndex={transcriptStart}
              messageIndexOffset={messageIndexOffset}
              live={liveEntries}
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
