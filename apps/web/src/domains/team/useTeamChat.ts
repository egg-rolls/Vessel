import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { useRefreshSignal } from '../../app/refresh';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useOptionalToast } from '../../components/ToastProvider';
import { isCursorOutOfWindowError, isHistoryChangedError } from '../../gateway/errors';
import { onRouteSnapshotInvalidated } from '../../gateway/snapshot-invalidation';
import type { TeamDetail, TeamMember, TeamMessage } from '../../gateway/types';
import { t } from '../../i18n';
import {
  applyTeamEvent,
  createTeamEventState,
  latestRotateFailure,
  mergeEarlierTeamPage,
  mergeMessages,
  sortMessages,
  type TeamEventState,
} from '../../state/teams';
import { resourceData } from '../../state/useResource';
import {
  teamDraftKey,
  useComposerChips,
  useComposerDraftStore,
  useComposerDraftText,
} from '../../stores/composerDraftStore';
import { teamDetailKey, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { isOnlineMember } from './member-status';
import { type MentionChip, memberDisplayName, mentionIds, shortAgentId } from './mention';
import type { TeamChatProps } from './team-chat-types';
import { buildTeamRows, type LocalSend, matchWrittenMessage, shouldFetchTeam } from './team-send';
import { DEFAULT_LIMIT, DEFAULT_MEMBERS_LIMIT, memberWindowFlags } from './team-window';

const TEAM_POLL_MS = 4_000;
const ROSTER_RELOAD_COOLDOWN_MS = 2_000;
const EMPTY_RESPONDING: ReadonlySet<string> = new Set();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTeamChat({
  client,
  hasToken,
  connectionState,
  epoch,
  teamId,
  nodeKey = 'local',
  permissions,
  asks,
  events,
  responding = EMPTY_RESPONDING,
  onDecidePermission,
  onRespondAsk,
  onOpenMember,
  onOpenSession,
  onBackToList,
  membersOpen,
  onCloseMembers,
  initialDetail,
  initialError,
}: TeamChatProps) {
  const [membersLimit, setMembersLimit] = useState(DEFAULT_MEMBERS_LIMIT);
  // 草稿 / chips 按 (node, team) 分槽缓存：切走再回来还在，只有发送成功才清。
  const draftKey = teamDraftKey(nodeKey, teamId);
  const draft = useComposerDraftText(draftKey);
  const chips = useComposerChips(draftKey);
  const writeDraft = useComposerDraftStore((state) => state.setText);
  const writeChips = useComposerDraftStore((state) => state.setChips);
  const clearDraft = useComposerDraftStore((state) => state.clear);
  const setDraft = useCallback(
    (value: string) => writeDraft(draftKey, value),
    [writeDraft, draftKey],
  );
  const setChips = useCallback(
    (next: MentionChip[]) => writeChips(draftKey, next),
    [writeChips, draftKey],
  );
  const [sends, setSends] = useState<LocalSend[]>([]);
  const [sending, setSending] = useState(false);
  const [retryHint, setRetryHint] = useState(false);
  const [messages, setMessages] = useState<TeamMessage[]>(() =>
    initialDetail ? sortMessages(initialDetail.messages) : [],
  );
  // 翻页状态：`hasEarlier` 只由首屏 / `before` 响应更新，尾页轮询不覆盖（§4.4）。
  const [hasEarlier, setHasEarlier] = useState(initialDetail?.messages_has_more === true);
  const hasEarlierRef = useRef(initialDetail?.messages_has_more === true);
  /** 首屏尾页的 `messages_has_more` 只采纳一次；之后只由 `before` 响应更新。 */
  const adoptedTailRef = useRef(initialDetail !== undefined);
  const earlierInFlightRef = useRef(false);
  /** 更早页请求在途（UI 用；同步重入由 `earlierInFlightRef` 兜住）。 */
  const [earlierLoading, setEarlierLoading] = useState(false);
  /**
   * 历史前缀被改写（`conflict` + `details.reason='history_changed'`）的告知。
   *
   * 已前插的更早页锚点失效，必须丢弃并从尾页重建：`historyReplaceRef` 让尾页合并
   * 走「整体替换」而不是 `mergeMessages`（后者会把失效的更早页留在前面）。
   * `historyReloadToken` 只用于让 TeamChatMain 在内容变化前抓一次滚动锚点。
   */
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [historyReloadToken, setHistoryReloadToken] = useState(0);
  const historyReplaceRef = useRef(false);
  // 切 Team 时清掉上一个 Team 的改写告知，不能跨 Team 残留。
  // biome-ignore lint/correctness/useExhaustiveDependencies: teamId 变化是重置条件
  useEffect(() => {
    setHistoryNotice(null);
  }, [teamId]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [retractTarget, setRetractTarget] = useState<TeamMessage | null>(null);
  const [retracting, setRetracting] = useState(false);
  const [retractError, setRetractError] = useState<string | undefined>();
  const [narrow, setNarrow] = useState(false);
  const toast = useOptionalToast();

  const eventStateRef = useRef<TeamEventState>(createTeamEventState());
  const lastRosterReloadAt = useRef(0);
  const rosterTimer = useRef<number | undefined>(undefined);
  /** 发送期间不发起新的 `teams.get`；保持 pollMs 稳定，避免 useResource 重跑。 */
  const sendingRef = useRef(false);
  const detailRef = useRef<TeamDetail | undefined>(initialDetail);

  // 成员栏：≥1024px 常驻右列（`enabled=false`，不介入）；≤1023px 变固定抽屉，
  // Esc / 遮罩 / 头部 × 都通过 `onCloseMembers` 回到 `useTeamsView`。
  // 入口在 Team 卡 ActionMenu，可选择项随菜单收起 → 不传 `returnFocusId`。
  const membersDrawerRef = useDrawerA11y({
    open: membersOpen,
    onClose: onCloseMembers,
    enabled: narrow,
  });

  const storeKey = teamDetailKey(nodeKey, teamId, 'chat');
  const detailState = useTeamStore((state) => state.details[storeKey]);
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const postTeam = useTeamStore((state) => state.post);
  const reload = () => {
    void loadDetail(
      nodeKey,
      teamId,
      client,
      { limit: DEFAULT_LIMIT, members_limit: membersLimit },
      'chat',
    );
  };

  usePolledAction(
    () => {
      const cached = detailRef.current;
      if (shouldFetchTeam(sendingRef.current, cached !== undefined) || !cached) {
        void loadDetail(
          nodeKey,
          teamId,
          client,
          { limit: DEFAULT_LIMIT, members_limit: membersLimit },
          'chat',
        );
      }
    },
    {
      enabled: hasToken,
      pollMs: TEAM_POLL_MS,
      deps: [epoch, teamId, membersLimit, nodeKey],
    },
  );
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // Team 栏卡片的 Refresh 走全局刷新信号：按当前窗口大小重拉，不重置草稿。
  const refreshFromSignal = useCallback(() => {
    reloadRef.current();
  }, []);
  useRefreshSignal(refreshFromSignal);
  sendingRef.current = sending;

  // gap / 历史改写后权威快照已过期：事件层只做失效信号，正文重取尾页。
  // 更早页保留在本地（尾页合并不会丢掉已加载的 before 页）。
  useEffect(() => onRouteSnapshotInvalidated(() => reloadRef.current()), []);

  /** 加载更早：`before` = 当前窗口首条 `message_id`；分页标志只由本响应更新。 */
  const loadEarlier = useCallback(() => {
    if (!hasEarlierRef.current || earlierInFlightRef.current) return;
    const first = messagesRef.current[0];
    if (!first) return;
    earlierInFlightRef.current = true;
    setEarlierLoading(true);
    void (async () => {
      try {
        const page = await client.getTeam(teamId, {
          limit: DEFAULT_LIMIT,
          before: first.message_id,
          members_limit: membersLimit,
        });
        const merged = mergeEarlierTeamPage(messagesRef.current, page);
        // 页里一条新内容都没有（空页 / 全是重复）：拿同一游标再拉只会空转，直接停手。
        const exhausted = merged.messages.length === messagesRef.current.length;
        setMessages(merged.messages);
        const more = merged.hasMore && !exhausted;
        hasEarlierRef.current = more;
        setHasEarlier(more);
      } catch (error) {
        if (isCursorOutOfWindowError(error)) {
          // 超出 64 MiB 回扫上限：停止翻页，一次性提示，保留已加载内容。
          hasEarlierRef.current = false;
          setHasEarlier(false);
          toast?.info(t('team.chat.historyOutOfWindow'));
        } else if (isHistoryChangedError(error)) {
          // 历史前缀被改写：行为对齐 chat —— 丢弃已前插的更早页、从尾页重建。
          // 告知走就地 notice（不是 toast）：历史加载是就地动作，浮层会让人丢锚点。
          // 只重取正文尾巴：不动 members / membersLimit（成员窗口是另一个查询维度）。
          setHistoryNotice('team.chat.historyChanged');
          setHistoryReloadToken((value) => value + 1);
          historyReplaceRef.current = true;
          reloadRef.current();
        } else {
          toast?.error(errorMessage(error));
        }
      } finally {
        earlierInFlightRef.current = false;
        setEarlierLoading(false);
      }
    })();
  }, [client, teamId, membersLimit, toast]);

  const detail = resourceData(detailState) ?? initialDetail;
  detailRef.current = detail;
  const team = detail?.team;
  const members = useMemo(() => detail?.members ?? [], [detail]);
  const connected = hasToken && connectionState === 'open';
  // 归档 Team 只读：日志仍可轮询查看，但不接受新消息。
  const archived = team?.archived_at !== undefined;

  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= RAIL_MAX_WIDTH);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(rosterTimer.current);
  }, []);

  // 轮询结果并入本地列表；乐观项单独保存，不按内容模糊删除。
  // 首屏尾页的 `messages_has_more` 只采纳一次；之后的尾页轮询不得覆盖翻页状态。
  useEffect(() => {
    const page = resourceData(detailState);
    if (!page) return;
    const replace = historyReplaceRef.current;
    if (replace) {
      // 历史被改写：更早页不再可信，整段换成新尾页（members / membersLimit 不受影响）。
      historyReplaceRef.current = false;
      setMessages(sortMessages(page.messages));
      const more = page.messages_has_more === true;
      hasEarlierRef.current = more;
      setHasEarlier(more);
      return;
    }
    if (page.messages.length > 0) setMessages((prev) => mergeMessages(prev, page.messages));
    if (!adoptedTailRef.current) {
      adoptedTailRef.current = true;
      const more = page.messages_has_more === true;
      hasEarlierRef.current = more;
      setHasEarlier(more);
    }
  }, [detailState]);

  // `run.*` / `agent.*` 事件只让 roster + 日志失效（250ms 合并一次定向 reload）；
  // 正文永远来自 `teams.get` 轮询，事件不构造消息。
  useEffect(() => {
    const memberSessionIds = new Set(
      members
        .map((member) => member.session_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    let state = eventStateRef.current;
    for (const entry of events) {
      if (entry.seq <= state.lastAppliedSeq) continue;
      state = applyTeamEvent(state, { ...entry.event, seq: entry.seq }, teamId, memberSessionIds);
    }
    // dirty 只触发一次失效刷新；后续没有新事件时不能反复 reload。
    const rosterDirty = state.rosterDirty;
    eventStateRef.current = rosterDirty ? { ...state, rosterDirty: false } : state;

    if (rosterDirty) {
      const now = Date.now();
      if (now - lastRosterReloadAt.current >= ROSTER_RELOAD_COOLDOWN_MS) {
        lastRosterReloadAt.current = now;
        window.clearTimeout(rosterTimer.current);
        rosterTimer.current = window.setTimeout(() => reloadRef.current(), 250);
      }
    }
  }, [events, teamId, members]);

  const memberById = useMemo(() => {
    const map = new Map<string, TeamMember>();
    for (const member of members) map.set(member.agent_id, member);
    return map;
  }, [members]);

  const resolveMember = (agentId: string): TeamMember | undefined => memberById.get(agentId);

  const agentLabel = (agentId: string): string => {
    const member = memberById.get(agentId);
    return member ? memberDisplayName(member) : shortAgentId(agentId);
  };

  // rotate 失败不写 Team 日志；用事件派生一条错误灰条，成功后自动消失。
  const rotateFailure = useMemo(() => latestRotateFailure(events, teamId), [events, teamId]);

  const rows = useMemo(() => buildTeamRows(messages, sends, teamId), [messages, sends, teamId]);

  const memberTotal = team?.member_count ?? members.length;
  const memberWindow = memberWindowFlags(members.length, memberTotal, membersLimit);
  // 窗口只含前 N 个成员；在线总数用服务端完整计数，缺失才回退窗口内计数。
  const onlineCount = team?.online_count ?? members.filter(isOnlineMember).length;

  /** 发送正文 + mentions；edit / resend / 普通发送共用同一条落盘路径。 */
  const submitContent = async (rawContent: string, mentions: string[]): Promise<boolean> => {
    const content = rawContent.trim();
    if (!content || sending || !hasToken || connectionState !== 'open' || archived) return false;
    const localId = `local:${crypto.randomUUID()}`;
    const ts = Date.now();

    setSends((prev) => [...prev, { localId, content, mentions, ts, status: 'sending' }]);
    setSending(true);
    sendingRef.current = true;

    try {
      const result = await postTeam(client, { team_id: teamId, content, mentions });
      setSends((prev) =>
        prev.map((send) =>
          send.localId === localId
            ? {
                ...send,
                status: 'sent',
                messageId: result.message_id,
                deliveries: result.delivered,
              }
            : send,
        ),
      );
      // reload 必须发生在发送锁释放之后，否则 load 会命中缓存分支而不发请求。
      setSending(false);
      sendingRef.current = false;
      reloadRef.current();
    } catch (error) {
      // 响应可能丢失：重新拉一次，按 content + mentions + ts 对账。
      let written: TeamMessage | undefined;
      try {
        const fresh = await client.getTeam(teamId, {
          limit: DEFAULT_LIMIT,
          members_limit: membersLimit,
        });
        setMessages((prev) => mergeMessages(prev, fresh.messages));
        written = matchWrittenMessage(fresh.messages, content, mentions, ts);
      } catch {
        // 对账失败：保留 failed，交给用户“再次发送”或刷新。
      }
      setSends((prev) =>
        prev.map((send) => {
          if (send.localId !== localId) return send;
          if (written) {
            return { ...send, status: 'sent', messageId: written.message_id };
          }
          return { ...send, status: 'failed', error: errorMessage(error) };
        }),
      );
      setSending(false);
      sendingRef.current = false;
      reloadRef.current();
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
    return true;
  };

  const handleSend = async () => {
    const content = draft.trim();
    const mentions = mentionIds(chips);
    const started = await submitContent(content, mentions);
    if (!started) return;
    clearDraft(draftKey);
    setRetryHint(false);
  };

  const handleRetry = (message: TeamMessage) => {
    setDraft(message.content);
    setChips(message.mentions.map((agentId) => ({ agentId, label: agentLabel(agentId) })));
    setRetryHint(true);
  };

  /** edit：回填正文 + mention chips；不发送、不删日志。 */
  const editMessage = (message: TeamMessage) => {
    setDraft(message.content);
    setChips(message.mentions.map((agentId) => ({ agentId, label: agentLabel(agentId) })));
    setRetryHint(false);
  };

  /** resend：复用发送路径，按正文 + mentions 追加一条新日志。 */
  const resendMessage = (message: TeamMessage) => {
    void submitContent(message.content, message.mentions);
  };

  const requestRetract = (message: TeamMessage) => {
    setRetractError(undefined);
    setRetractTarget(message);
  };

  const cancelRetract = () => {
    if (retracting) return;
    setRetractTarget(null);
    setRetractError(undefined);
  };

  const confirmRetract = async () => {
    const target = retractTarget;
    if (!target || retracting) return;
    setRetracting(true);
    setRetractError(undefined);
    try {
      await client.retractTeam({ team_id: teamId, message_id: target.message_id });
      setRetractTarget(null);
      toast?.success(t('team.message.retractDone'));
      reloadRef.current();
    } catch (error) {
      // 失败保留弹窗与错误，用户可重试或取消。
      const message = errorMessage(error);
      setRetractError(message);
      toast?.error(message);
    } finally {
      setRetracting(false);
    }
  };

  const openMember = (agentId: string) => {
    // 成员详情是另一个域的路由；先收起成员栏，避免返回 Team 时抽屉仍开着。
    onCloseMembers();
    onOpenMember(agentId);
  };

  const error =
    detailState?.status === 'error'
      ? { message: detailState.error, code: detailState.code }
      : initialError;
  const firstLoading = !detail && !error;

  return {
    team,
    teamId,
    archived,
    historyNotice,
    dismissHistoryNotice: () => setHistoryNotice(null),
    historyReloadToken,
    members,
    memberTotal,
    onlineCount,
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
  };
}
