import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import type {
  AskUserRequest,
  MessageRef,
  PermissionRequest,
  TeamDetail,
  TeamMember,
  TeamMessage,
} from '../../gateway/types';
import { t } from '../../i18n';
import { useStickyBottom } from '../chat/useStickyBottom';
import type { MentionChip } from './mention';
import { TeamComposer } from './TeamComposer';
import type { TeamMessageView } from './TeamMessageRow';
import { TeamPendingBar } from './TeamPendingBar';
import { TeamTranscript } from './TeamTranscript';
import type {
  TeamChatClient,
  TeamChatDecidePermission,
  TeamChatRespondAsk,
} from './team-chat-types';
import {
  captureScrollAnchor,
  EARLIER_LOAD_THRESHOLD_PX,
  isNearTop,
  restoreScrollAnchor,
  type ScrollAnchor,
  teamChatResetKey,
  teamFollowKey,
} from './team-scroll';

/**
 * 顶部无感加载更早：贴近顶部（< 120px）自动加载一页，加载后补回滚动锚点。
 *
 * - `armed`：一次贴近顶部只触发一页，锚点补偿把 scrollTop 带离顶部后才重新武装。
 * - `anchor`：请求时记下 scrollTop / scrollHeight，新页插入 DOM 后（`useLayoutEffect`，
 *   绘制前）把高度差补进 scrollTop，视觉位置不动。
 * - 是否还有更早**只**由服务端 `messages_has_more` 决定（`hasMore`）：契约 §4.4 已把
 *   「下一页条数没变多＝到头」的客户端探针删掉，这里不再猜测。
 * - `loading`：`useTeamChat` 的请求在途标志。请求结束但一条也没多（失败 /
 *   `cursor_out_of_window`）时丢掉锚点，别把随后的无关增长当成翻页来回补偿。
 * - `filledAt`：视口没被填满时滚不动、靠滚动永远触发不到更早历史，主动补一页；
 *   上一页没有带来内容增长（scrollHeight 不变）就停，避免死循环。
 */
function useEarlierPaging({
  box,
  hasMore,
  loading,
  scope,
  onLoadEarlier,
}: {
  box: { current: HTMLDivElement | null };
  hasMore: boolean;
  /** 外部请求在途：期间不重复触发。 */
  loading: boolean;
  /** 切换 Team 时重置（切走再回来应该还能往前拉）。 */
  scope: string;
  onLoadEarlier: () => void;
}): { onScroll: () => void; loadedPages: number } {
  const armed = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const filledAt = useRef<number | null>(null);
  const [loadedPages, setLoadedPages] = useState(0);

  // 切 Team：清掉锚点 / 武装状态，别把上一个 Team 的结论带过来。
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope 变化就是重置条件（函数体只写 ref）
  useEffect(() => {
    armed.current = true;
    anchor.current = null;
    filledAt.current = null;
  }, [scope]);

  const request = useCallback(() => {
    const element = box.current;
    if (!element || !hasMore || loading) return;
    armed.current = false;
    anchor.current = captureScrollAnchor(element);
    onLoadEarlier();
  }, [box, hasMore, loading, onLoadEarlier]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const saved = anchor.current;
    if (saved) {
      if (restoreScrollAnchor(element, saved)) {
        // 新页真的插到了上方：视口已经补偿，播报「已加载更早消息」。
        anchor.current = null;
        setLoadedPages((value) => value + 1);
      } else if (!loading) {
        // 请求已结束却一条也没多（失败 / cursor_out_of_window）：丢掉锚点。
        anchor.current = null;
      }
      return;
    }
    if (
      !hasMore ||
      loading ||
      element.scrollHeight > element.clientHeight + EARLIER_LOAD_THRESHOLD_PX
    ) {
      filledAt.current = null;
      return;
    }
    if (filledAt.current === element.scrollHeight) return;
    filledAt.current = element.scrollHeight;
    request();
  });

  const onScroll = useCallback(() => {
    const element = box.current;
    if (!element) return;
    const saved = anchor.current;
    if (saved) {
      // 新页还没到（高度没变）但用户已经自己滚走了：放弃这次锚定，不抢回位置。
      if (
        element.scrollHeight === saved.scrollHeight &&
        Math.abs(element.scrollTop - saved.scrollTop) > 4
      ) {
        anchor.current = null;
        armed.current = true;
        return;
      }
      // 请求在途：不重复触发同一页。
      return;
    }
    if (!isNearTop(element.scrollTop)) {
      armed.current = true;
      return;
    }
    if (!armed.current) return;
    request();
  }, [box, request]);

  return { onScroll, loadedPages };
}

export interface TeamChatMainProps {
  /** 稳定 chat key：detail 尚未到达时也能区分会话。 */
  teamId: string;
  detail: TeamDetail | undefined;
  error: { message: string; code?: string } | undefined;
  hasToken: boolean;
  firstLoading: boolean;
  rows: readonly TeamMessageView[];
  resolveMember: (agentId: string) => TeamMember | undefined;
  agentLabel: (agentId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onRetrySend: (message: TeamMessage) => void;
  onEditMessage: (message: TeamMessage) => void;
  onResendMessage: (message: TeamMessage) => void;
  onRetractMessage: (message: TeamMessage) => void;
  onRefresh: () => void;
  /** 服务端 `messages_has_more`：窗口前还有更早消息。 */
  hasEarlier: boolean;
  /** 更早页请求在途（`useTeamChat.loadEarlier`）：期间不重复触发。 */
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** 历史前缀被改写（`history_changed`）的就地告知（i18n key）；null = 无。 */
  historyNotice: string | null;
  onDismissHistoryNotice: () => void;
  /** 每次 `history_changed` 自增：内容被整体替换前用来抓一次滚动锚点。 */
  historyReloadToken: number;
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
  /** 待发送的附件引用（只有路径）；与会话页同一份草稿槽机制。 */
  refs: readonly MessageRef[];
  onRemoveRef: (index: number) => void;
  onAddRef: (ref: MessageRef) => boolean;
  /** 引用文件弹层的目录浏览数据源（本 Team 所在节点；与 `onAddRef` 一起决定是否出工具栏入口）。 */
  client: TeamChatClient;
  onSend: () => void;
  sending: boolean;
  /** 发送受理序号（每次受理自增，send / resend 共用）：变化即贴底。 */
  sendTick: number;
  archived: boolean;
  targetLabel: string;
  retryHint: boolean;
  /**
   * 只覆盖「通知 / 页头 + 转录区」的浮层（当前是内容列宽度手柄）。
   * 它被放进 content-stage，纵范围到转录区底部为止，不压输入区。
   */
  overlay?: ReactNode;
}

export function TeamChatMain({
  teamId,
  detail,
  error,
  hasToken,
  firstLoading,
  rows,
  resolveMember,
  agentLabel,
  onOpenSession,
  onRetrySend,
  onEditMessage,
  onResendMessage,
  onRetractMessage,
  onRefresh,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  historyNotice,
  onDismissHistoryNotice,
  historyReloadToken,
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
  refs,
  onRemoveRef,
  onAddRef,
  client,
  onSend,
  sending,
  sendTick,
  archived,
  targetLabel,
  retryHint,
  overlay,
}: TeamChatMainProps) {
  // detail 到达时再 settle 一次（等布局稳定再贴底）；加载更早历史不改这个 key。
  const resetKey = teamChatResetKey(teamId, detail?.team.team_id);
  // 用“最后一条消息的身份”而不是 rows.length：自动加载更早历史只在前方追加旧消息。
  const followKey = teamFollowKey(rows);
  const { scrollRef, pinned, onScroll, scrollToBottom, userIntentProps } = useStickyBottom({
    resetKey,
    followKey,
    sendTick,
  });
  // 无感加载更早：滚动到顶部附近自动加载一页，并在插入后补回滚动锚点。
  const scrollBox = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollBox.current = element;
      scrollRef(element);
    },
    [scrollRef],
  );
  const paging = useEarlierPaging({
    box: scrollBox,
    hasMore: hasEarlier,
    loading: loadingEarlier,
    scope: resetKey,
    onLoadEarlier,
  });

  /**
   * 历史被改写（`history_changed`）→ 内容整体替换：替换前抓一次锚点，替换后按高度差
   * 回填，避免「重取尾页」把视口甩到顶部。贴底态（pinned）则维持贴底。
   * 抓取必须在内容变化之前，因此挂在 token 变化（请求发出）而不是渲染完成后。
   */
  const historyAnchor = useRef<ScrollAnchor | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  useEffect(() => {
    if (historyReloadToken === 0) return;
    const element = scrollBox.current;
    historyAnchor.current = element ? captureScrollAnchor(element) : null;
  }, [historyReloadToken]);
  useLayoutEffect(() => {
    const saved = historyAnchor.current;
    const element = scrollBox.current;
    if (!saved || !element) return;
    // 内容还没换掉（请求在途）：等下一次布局再补。
    if (element.scrollHeight === saved.scrollHeight) return;
    restoreScrollAnchor(element, saved);
    historyAnchor.current = null;
    if (pinnedRef.current) {
      // 贴底态：历史改写后仍停在最新一条，不因为高度变化被判定为“用户上滚”。
      element.scrollTop = element.scrollHeight;
    }
  });

  const handleScroll = () => {
    onScroll();
    paging.onScroll();
  };

  return (
    <div className="team-chat-main">
      {/* 「通知 + 转录区」与输入区分层：宽度手柄放在这里，纵范围不跨进输入区。 */}
      <div className="content-stage">
        {overlay}
        {detail && error && <StaleNotice message={t('team.error.stale')} onRetry={onRefresh} />}
        {historyNotice && (
          <StaleNotice message={t(historyNotice)} onDismiss={onDismissHistoryNotice} />
        )}
        <div
          className="team-transcript-scroll"
          ref={setScrollRef}
          onScroll={handleScroll}
          {...userIntentProps}
        >
          {!hasToken ? (
            <NotEnabledState
              title={t('team.error.noToken')}
              reason={t('team.error.noTokenReason')}
            />
          ) : firstLoading && rows.length === 0 ? (
            // 只有「一行都没有」才换成骨架：切到已缓存过的 Team 时 rows 已由
            // `useTeamChat` 的身份重置从缓存播下，这里不该再闪一次 LoadingState。
            <LoadingState rows={3} />
          ) : !detail && rows.length === 0 ? (
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
              motionResetKey={resetKey}
              resolveMember={resolveMember}
              resolveMemberLabel={agentLabel}
              onViewMemberSession={(_agentId, sessionId) => onOpenSession(sessionId)}
              onRetrySend={onRetrySend}
              onEditMessage={onEditMessage}
              onResendMessage={onResendMessage}
              onRetractMessage={onRetractMessage}
            />
          )}

          {/* 无感加载更早：不再渲染按钮 / 截断提示，只留读屏播报（不占视觉）。 */}
          <span className="sr-only" aria-live="polite">
            {paging.loadedPages > 0 ? t('team.chat.loadedEarlier') : ''}
          </span>
          {!pinned && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>
              {t('chat.toBottom')}
            </button>
          )}
        </div>
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
          refs={refs}
          onRemoveRef={onRemoveRef}
          onAddRef={onAddRef}
          client={client}
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
