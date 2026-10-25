/**
 * Team 群聊容器：轮询 `teams.get` + 事件即时插入 + 乐观发送。
 *
 * - 权威消息源是轮询；`agent.reply.posted` 只按 `message_id` 插入 / 覆盖；
 * - 发送串行（无幂等键）：发送期间停轮询，成功后 reload 对账；
 * - 失败不自动重试；reload 找不到同内容消息才标 failed；
 * - “再次发送”只把内容填回 Composer，由用户再次确认后作为新日志。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { Button, cn } from '../../components/ui';
import type {
  AskUserRequest,
  PermissionRequest,
  TeamDetail,
  TeamMember,
  TeamMessage,
  TeamPostResult,
} from '../../gateway/types';
import { t } from '../../i18n';
import type { StoredEvent } from '../../state/events';
import {
  applyTeamEvent,
  createTeamEventState,
  latestRotateFailure,
  mergeMessages,
  sortMessages,
  type TeamEventState,
} from '../../state/teams';
import { resourceData, useResource } from '../../state/useResource';
import { isOnlineMember } from './member-status';
import { type MentionChip, memberDisplayName, mentionIds, shortAgentId } from './mention';
import { TeamComposer } from './TeamComposer';
import { TeamMemberSidebar } from './TeamMemberSidebar';
import { TeamTranscript } from './TeamTranscript';
import { buildTeamRows, type LocalSend, matchWrittenMessage, shouldFetchTeam } from './team-send';
import {
  DEFAULT_LIMIT,
  DEFAULT_MEMBERS_LIMIT,
  memberWindowFlags,
  nextLimitFor,
  nextMembersLimitFor,
  teamWindowFlags,
} from './team-window';

const TEAM_POLL_MS = 4_000;
/** 与 app/layout 的 RAIL_MAX_WIDTH 一致；不直接 import 以免在 SSR 里访问 window。 */
const NARROW_MAX_WIDTH = 1023;
const ROSTER_RELOAD_COOLDOWN_MS = 2_000;

export interface TeamChatClient {
  getTeam(teamId: string, opts?: { limit?: number; members_limit?: number }): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult>;
}

export interface TeamChatProps {
  client: TeamChatClient;
  hasToken: boolean;
  connectionState: string;
  epoch: number;
  tenantEpoch: number;
  teamId: string;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  events: readonly StoredEvent[];
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onBackToList: () => void;
  /** 测试 / 预览注入，避免 SSR 依赖 effect。 */
  initialDetail?: TeamDetail;
  initialLimit?: number;
  initialError?: { message: string; code?: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TeamChat({
  client,
  hasToken,
  connectionState,
  epoch,
  tenantEpoch,
  teamId,
  permissions,
  asks,
  events,
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

  const eventStateRef = useRef<TeamEventState>(createTeamEventState());
  const lastEventMessagesRef = useRef<TeamMessage[]>(eventStateRef.current.messages);
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

  const resource = useResource({
    load: () => {
      const cached = detailRef.current;
      if (!shouldFetchTeam(sendingRef.current, cached !== undefined) && cached) {
        return Promise.resolve(cached);
      }
      return client.getTeam(teamId, { limit, members_limit: membersLimit });
    },
    enabled: hasToken,
    pollMs: TEAM_POLL_MS,
    deps: [epoch, tenantEpoch, teamId, limit, membersLimit],
    ...(initialDetail !== undefined ? { initialData: initialDetail } : {}),
  });
  const reloadRef = useRef(resource.reload);
  reloadRef.current = resource.reload;
  sendingRef.current = sending;

  const detail = resourceData(resource.state) ?? initialDetail;
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
    const incoming = resourceData(resource.state)?.messages;
    if (!incoming || incoming.length === 0) return;
    setMessages((prev) => mergeMessages(prev, incoming));
  }, [resource.state]);

  // `agent.reply.posted` 立即插入；其它 agent.* 事件只做 roster 失效刷新。
  useEffect(() => {
    let state = eventStateRef.current;
    for (const entry of events) {
      if (entry.seq <= state.lastAppliedSeq) continue;
      state = applyTeamEvent(state, { ...entry.event, seq: entry.seq }, teamId);
    }
    // dirty 只触发一次失效刷新；后续没有新事件时不能反复 reload。
    const rosterDirty = state.rosterDirty;
    eventStateRef.current = rosterDirty ? { ...state, rosterDirty: false } : state;

    if (state.messages !== lastEventMessagesRef.current) {
      lastEventMessagesRef.current = state.messages;
      setMessages((prev) => mergeMessages(prev, state.messages));
    }

    if (rosterDirty) {
      const now = Date.now();
      if (now - lastRosterReloadAt.current >= ROSTER_RELOAD_COOLDOWN_MS) {
        lastRosterReloadAt.current = now;
        window.clearTimeout(rosterTimer.current);
        rosterTimer.current = window.setTimeout(() => reloadRef.current(), 250);
      }
    }
  }, [events, teamId]);

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

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || sending || !hasToken || connectionState !== 'open' || archived) return;
    const mentions = mentionIds(chips);
    const localId = `local:${crypto.randomUUID()}`;
    const ts = Date.now();

    setSends((prev) => [...prev, { localId, content, mentions, ts, status: 'sending' }]);
    setDraft('');
    setChips([]);
    setRetryHint(false);
    setSending(true);
    sendingRef.current = true;

    try {
      const result = await client.postTeam({ team_id: teamId, content, mentions });
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
  };

  const handleRetry = (message: TeamMessage) => {
    setDraft(message.content);
    setChips(message.mentions.map((agentId) => ({ agentId, label: agentLabel(agentId) })));
    setRetryHint(true);
  };

  const openMember = (agentId: string) => {
    setMembersOpen(false);
    onOpenMember(agentId);
  };

  const { canLoadEarlier, historyLimited, visibleCount } = teamWindowFlags(limit, rows.length);
  const error =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : initialError;
  const firstLoading = !detail && !error;

  return (
    <section className="team-chat" aria-label={team?.name ?? teamId}>
      <header className="team-chat-head">
        <div className="min-w-0">
          <h1 className="font-serif text-title font-semibold wrap-anywhere">
            {team?.name || teamId}
          </h1>
          <div className="mt-1.25 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono text-2xs text-faint">{teamId}</span>
            {team?.workspace && (
              <span className="max-w-80 truncate font-mono" title={team.workspace}>
                {team.workspace}
              </span>
            )}
            <span>
              {t('team.chat.descriptionLabel')}: {team?.description || '—'}
            </span>
            <span className="font-mono">
              {t('team.chat.defaultPrincipalLabel')}: {team?.default_principal || '—'}
            </span>
            {archived && (
              <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
                {t('teams.chat.archived')}
                <span className="text-xs text-faint"> {t('teams.chat.archivedHint')}</span>
              </span>
            )}
            <span>
              {t('team.chat.memberWindow', { shown: members.length, total: memberTotal })}
            </span>
            <span>{t('team.chat.onlineCount', { count: onlineCount })}</span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1.5">
          <Button
            id="team-members-toggle"
            className="team-chat-members-toggle hidden max-wide:inline-flex"
            aria-expanded={membersOpen}
            aria-controls="team-members"
            onClick={() => setMembersOpen((value) => !value)}
          >
            {membersOpen ? t('team.a11y.closeMembers') : t('team.chat.members')}
          </Button>
          <Button className="team-chat-back hidden max-wide:inline-flex" onClick={onBackToList}>
            {t('team.chat.backToList')}
          </Button>
          <Button onClick={resource.reload} disabled={!hasToken || resource.refreshing}>
            {resource.refreshing ? t('team.chat.refreshing') : t('team.chat.refresh')}
          </Button>
        </div>
      </header>

      <div className="team-chat-body">
        <div className="team-chat-main">
          {detail && error && (
            <StaleNotice message={t('team.error.stale')} onRetry={resource.reload} />
          )}
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
              <NotEnabledState
                title={t('team.error.noToken')}
                reason={t('team.error.noTokenReason')}
              />
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
                  onRetry={resource.reload}
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
                onRetrySend={handleRetry}
              />
            )}

            {canLoadEarlier && (
              <button
                type="button"
                className="load-earlier self-center"
                onClick={() => setLimit(nextLimitFor(limit))}
              >
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
            <TeamComposer
              value={draft}
              onChange={(value) => {
                setDraft(value);
                if (retryHint) setRetryHint(false);
              }}
              mentions={chips}
              onMentionsChange={setChips}
              onSend={() => void handleSend()}
              sending={sending}
              hasToken={hasToken}
              connected={connected && !archived}
              disabled={archived}
              members={members}
              targetLabel={team?.name ?? teamId}
              retryHint={retryHint}
            />
          </div>
        </div>

        <aside
          id="team-members"
          ref={membersDrawerRef}
          {...(narrow ? { role: 'dialog' as const, 'aria-modal': membersOpen } : {})}
          className={`team-members-column ${membersOpen ? 'open' : ''}`.trim()}
          aria-label={t('team.a11y.memberList')}
          inert={narrow && !membersOpen ? true : undefined}
          aria-hidden={narrow && !membersOpen ? true : undefined}
        >
          <TeamMemberSidebar
            members={members}
            total={memberTotal}
            permissions={permissions}
            asks={asks}
            onOpenMember={openMember}
            onOpenSession={onOpenSession}
            onClose={narrow ? () => setMembersOpen(false) : undefined}
          />
          {memberWindow.canLoadMore && (
            <button
              type="button"
              className="load-more mx-3 my-2"
              onClick={() => setMembersLimit(nextMembersLimitFor(membersLimit))}
            >
              {t('team.chat.loadMoreMembers')}
            </button>
          )}
          {memberWindow.capped && (
            <p className="m-0 self-center font-mono text-xs text-faint" role="status">
              {t('team.chat.membersCapped', { shown: members.length, total: memberTotal })}
            </p>
          )}
        </aside>

        {narrow && membersOpen && (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label={t('team.a11y.closeMembers')}
            onClick={() => setMembersOpen(false)}
          />
        )}
      </div>
    </section>
  );
}
