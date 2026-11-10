import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { useStickyBottom } from '../chat/useStickyBottom';
import type { MentionChip } from './mention';
import { TeamComposer } from './TeamComposer';
import type { TeamMessageView } from './TeamMessageRow';
import { TeamPendingBar } from './TeamPendingBar';
import { TeamTranscript } from './TeamTranscript';
import type { TeamChatDecidePermission, TeamChatRespondAsk } from './team-chat-types';
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
 * - 是否还有更早由服务端 `messages_has_more` 决定（`hasMore`），不再用探针探测。
 * - `filledAt`：视口没被填满时滚不动、靠滚动永远触发不到更早历史，主动补一页；
 *   上一页没有带来内容增长（scrollHeight 不变）就停，避免死循环。
 */
function useEarlierPaging({
  box,
  hasMore,
  scope,
  onLoadEarlier,
}: {
  box: { current: HTMLDivElement | null };
  hasMore: boolean;
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
    if (!element || !hasMore) return;
    armed.current = false;
    anchor.current = captureScrollAnchor(element);
    setLoadedPages((value) => value + 1);
    onLoadEarlier();
  }, [box, hasMore, onLoadEarlier]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const saved = anchor.current;
    if (saved) {
      if (restoreScrollAnchor(element, saved)) anchor.current = null;
      return;
    }
    if (!hasMore || element.scrollHeight > element.clientHeight + EARLIER_LOAD_THRESHOLD_PX) {
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
  rotateFailure: RotateFailureView | null;
  resolveMember: (agentId: string) => TeamMember | undefined;
  agentLabel: (agentId: string) => string;
  onOpenSession: (sessionId: string) => void;
  onRetrySend: (message: TeamMessage) => void;
  onEditMessage: (message: TeamMessage) => void;
  onResendMessage: (message: TeamMessage) => void;
  onRetractMessage: (message: TeamMessage) => void;
  onRefresh: () => void;
  /** 窗口前还有更早消息：滚动到顶部附近时自动加载一页。 */
  canLoadEarlier: boolean;
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
  teamId,
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
  onEditMessage,
  onResendMessage,
  onRetractMessage,
  onRefresh,
  canLoadEarlier,
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
  // detail 到达时再 settle 一次（等布局稳定再贴底）；加载更早历史不改这个 key。
  const resetKey = teamChatResetKey(teamId, detail?.team.team_id);
  // 用“最后一条消息的身份”而不是 rows.length：自动加载更早历史只在前方追加旧消息。
  const followKey = teamFollowKey(rows);
  const { scrollRef, pinned, onScroll, scrollToBottom, userIntentProps } = useStickyBottom({
    resetKey,
    followKey,
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
    hasMore: canLoadEarlier,
    scope: resetKey,
    onLoadEarlier,
  });
  const handleScroll = () => {
    onScroll();
    paging.onScroll();
  };

  return (
    <div className="team-chat-main">
      {detail && error && <StaleNotice message={t('team.error.stale')} onRetry={onRefresh} />}
      <div
        className="team-transcript-scroll"
        ref={setScrollRef}
        onScroll={handleScroll}
        {...userIntentProps}
      >
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
