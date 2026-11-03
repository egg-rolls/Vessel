import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useOptionalToast } from '../../components/ToastProvider';
import type { TeamDetail, TeamMember, TeamMessage } from '../../gateway/types';
import { t } from '../../i18n';
import {
  applyTeamEvent,
  createTeamEventState,
  latestRotateFailure,
  mergeMessages,
  sortMessages,
  type TeamEventState,
} from '../../state/teams';
import { resourceData } from '../../state/useResource';
import { teamDetailKey, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { isOnlineMember } from './member-status';
import { type MentionChip, memberDisplayName, mentionIds, shortAgentId } from './mention';
import type { TeamChatProps } from './team-chat-types';
import { buildTeamRows, type LocalSend, matchWrittenMessage, shouldFetchTeam } from './team-send';
import {
  DEFAULT_LIMIT,
  DEFAULT_MEMBERS_LIMIT,
  memberWindowFlags,
  teamWindowFlags,
} from './team-window';

const TEAM_POLL_MS = 4_000;
/** 与 app/layout 的 RAIL_MAX_WIDTH 一致；不直接 import 以免在 SSR 里访问 window。 */
const NARROW_MAX_WIDTH = 1023;
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
  tenantEpoch,
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
  initialDetail,
  initialLimit = DEFAULT_LIMIT,
  initialError,
}: TeamChatProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [membersLimit, setMembersLimit] = useState(DEFAULT_MEMBERS_LIMIT);
  const [draft, setDraft] = useState('');
  const [chips, setChips] = useState<MentionChip[]>([]);
  const [sends, setSends] = useState<LocalSend[]>([]);
  const [sending, setSending] = useState(false);
  const [retryHint, setRetryHint] = useState(false);
  const [messages, setMessages] = useState<TeamMessage[]>(() =>
    initialDetail ? sortMessages(initialDetail.messages) : [],
  );
  const [membersOpen, setMembersOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [retractTarget, setRetractTarget] = useState<TeamMessage | null>(null);
  const [retracting, setRetracting] = useState(false);
  const [retractError, setRetractError] = useState<string | undefined>();
  const toast = useOptionalToast();

  const eventStateRef = useRef<TeamEventState>(createTeamEventState());
  const lastRosterReloadAt = useRef(0);
  const rosterTimer = useRef<number | undefined>(undefined);
  /** 发送期间不发起新的 `teams.get`；保持 pollMs 稳定，避免 useResource 重跑。 */
  const sendingRef = useRef(false);
  const detailRef = useRef<TeamDetail | undefined>(initialDetail);

  const membersDrawerRef = useDrawerA11y({
    open: membersOpen,
    onClose: () => setMembersOpen(false),
    enabled: narrow,
    returnFocusId: 'team-members-toggle',
  });

  const storeKey = teamDetailKey(nodeKey, teamId, 'chat');
  const detailState = useTeamStore((state) => state.details[storeKey]);
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const postTeam = useTeamStore((state) => state.post);
  // 只有显式刷新（按钮 / 全局刷新信号 / 发送后对账）才显示“正在刷新”；
  // 4s 后台轮询复用同一 store 状态，但不应让顶部按钮每轮闪一次。
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const manualRefreshGen = useRef(0);
  const reload = () => {
    const gen = ++manualRefreshGen.current;
    setManualRefreshing(true);
    void loadDetail(
      nodeKey,
      teamId,
      client,
      { limit, members_limit: membersLimit },
      'chat',
    ).finally(() => {
      if (manualRefreshGen.current === gen) setManualRefreshing(false);
    });
  };

  usePolledAction(
    () => {
      const cached = detailRef.current;
      if (shouldFetchTeam(sendingRef.current, cached !== undefined) || !cached) {
        void loadDetail(nodeKey, teamId, client, { limit, members_limit: membersLimit }, 'chat');
      }
    },
    {
      enabled: hasToken,
      pollMs: TEAM_POLL_MS,
      deps: [epoch, tenantEpoch, teamId, limit, membersLimit, nodeKey],
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

  const detail = resourceData(detailState) ?? initialDetail;
  detailRef.current = detail;
  const team = detail?.team;
  const members = useMemo(() => detail?.members ?? [], [detail]);
  const connected = hasToken && connectionState === 'open';
  // 归档 Team 只读：日志仍可轮询查看，但不接受新消息。
  const archived = team?.archived_at !== undefined;

  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= NARROW_MAX_WIDTH);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(rosterTimer.current);
  }, []);

  // 轮询结果并入本地列表；乐观项单独保存，不按内容模糊删除。
  useEffect(() => {
    const incoming = resourceData(detailState)?.messages;
    if (!incoming || incoming.length === 0) return;
    setMessages((prev) => mergeMessages(prev, incoming));
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
        const fresh = await client.getTeam(teamId, { limit, members_limit: membersLimit });
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
    setDraft('');
    setChips([]);
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
    setMembersOpen(false);
    onOpenMember(agentId);
  };

  const { canLoadEarlier, historyLimited, visibleCount } = teamWindowFlags(limit, rows.length);
  const error =
    detailState?.status === 'error'
      ? { message: detailState.error, code: detailState.code }
      : initialError;
  const firstLoading = !detail && !error;
  // 后台轮询不会改写这个值；只有 reload() 的请求生命周期内为 true。
  const refreshing = manualRefreshing;

  return {
    team,
    teamId,
    archived,
    members,
    memberTotal,
    onlineCount,
    membersOpen,
    setMembersOpen,
    narrow,
    membersDrawerRef,
    detail,
    error,
    firstLoading,
    refreshing,
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
    canLoadEarlier,
    historyLimited,
    visibleCount,
    limit,
    setLimit,
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
