/**
 * 成员详情：当前 Body + 已退役 Body + 旧 Body 只读 transcript。
 *
 * Body 历史优先服务端 `member.body_history`；只有字段缺失时才使用
 * `agent.rotated / agent.retired` 的本次页面观察值，并明确标注。
 * 不提供配置 / rotate / close 操作。
 */
import { type ReactNode, useMemo } from 'react';
import { Markdown } from '../../components/Markdown';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button } from '../../components/ui';
import { formatClock, formatTimestamp, localDayKey, localDayLabel } from '../../format';
import type {
  Message,
  SessionDetail,
  TeamBodyHistoryEntry,
  TeamDetail,
  TeamMember,
} from '../../gateway/types';
import { t } from '../../i18n';
import type { StoredEvent } from '../../state/events';
import {
  applyTeamEvent,
  createTeamEventState,
  type ObservedBody,
  observedBodyHistory,
  preferBodyHistory,
  serverBodyHistory,
} from '../../state/teams';
import { resourceData, useResource } from '../../state/useResource';
import { memberStatus } from './member-status';
import { shortAgentId } from './mention';
import type { TeamChatClient } from './TeamChat';

export interface MemberDetailClient extends TeamChatClient {
  getSession(sessionId: string): Promise<SessionDetail>;
}

export interface MemberDetailProps {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  tenantEpoch: number;
  teamId: string;
  memberId: string;
  bodyId?: string;
  events: readonly StoredEvent[];
  /** 返回群聊。 */
  onBack: () => void;
  /** 返回成员详情（去掉 ?body=）。 */
  onBackToMember: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenBody: (sessionId: string) => void;
  initialDetail?: TeamDetail;
  initialSession?: SessionDetail;
  initialError?: { message: string; code?: string };
}

function SessionTranscript({ messages }: { messages: readonly Message[] }) {
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  // 只读会话消息没有稳定 id：用局部序号做 key，稳定且不受排序影响。
  let keySeq = 0;
  for (const message of messages) {
    const key = `message-${keySeq++}`;
    const ts = message.timestamp;
    const day = ts !== undefined ? localDayKey(ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div className="day-divider team-day-divider" key={`day-${day}`}>
          <span>{localDayLabel(ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (message.role === 'system') {
      nodes.push(
        <div className="team-notice" key={key} role="status">
          <span className="team-notice-tag">{t('team.message.systemTag')}</span>
          <span>{message.content}</span>
        </div>,
      );
      continue;
    }
    nodes.push(
      <div className={`team-readonly-message team-readonly-${message.role}`} key={key}>
        <div className="team-message-meta">
          <span className="team-message-sender mono">{message.name || message.role}</span>
          {ts !== undefined && (
            <time className="team-message-time" dateTime={new Date(ts).toISOString()}>
              {formatClock(ts)}
            </time>
          )}
        </div>
        {message.role === 'tool' ? (
          <pre className="team-readonly-tool">{message.content}</pre>
        ) : (
          <div className="team-message-bubble">
            <Markdown className="team-message-text" text={message.content} />
          </div>
        )}
      </div>,
    );
  }
  return <div className="team-transcript">{nodes}</div>;
}

function BodyTranscript({
  client,
  hasToken,
  epoch,
  bodyId,
  initialSession,
  onBackToMember,
}: {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  bodyId: string;
  initialSession?: SessionDetail;
  onBackToMember: () => void;
}) {
  const resource = useResource({
    load: () => client.getSession(bodyId),
    enabled: hasToken,
    deps: [bodyId, epoch],
    ...(initialSession !== undefined ? { initialData: initialSession } : {}),
  });
  const session = resourceData(resource.state);
  const error =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : undefined;

  if (!hasToken) {
    return (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  }

  return (
    <div className="team-member-detail team-body-view">
      <header className="team-chat-head">
        <div className="team-chat-heading">
          <h1 className="team-chat-title">{t('team.member.title')}</h1>
          <div className="team-chat-meta">
            <span className="mono">{bodyId}</span>
          </div>
        </div>
        <div className="team-chat-actions">
          <Button onClick={onBackToMember}>{t('breadcrumb.team.member')}</Button>
        </div>
      </header>
      <div className="team-transcript-scroll">
        {!session && !error ? (
          <LoadingState rows={3} />
        ) : !session ? (
          <ErrorState
            message={error?.message ?? t('team.error.loadFailed')}
            onRetry={resource.reload}
          />
        ) : session.messages.length === 0 ? (
          <EmptyState title={t('team.chat.empty')} />
        ) : (
          <SessionTranscript messages={session.messages} />
        )}
      </div>
    </div>
  );
}

function BodyHistoryList({
  entries,
  observed,
  onOpenBody,
}: {
  entries: readonly TeamBodyHistoryEntry[];
  observed: readonly ObservedBody[];
  onOpenBody: (sessionId: string) => void;
}) {
  if (observed.length > 0) {
    return (
      <ul className="team-body-history">
        {observed.map((body) => (
          <li className="team-body-history-item" key={body.session_id}>
            <div className="team-body-history-main">
              <span className="mono">{body.session_id}</span>
              <span className="dim">{t('team.member.epoch', { epoch: body.epoch })}</span>
              <span className="dim">
                {t('team.member.observedAt', { time: formatTimestamp(body.observed_at) })}
              </span>
              {body.reason && <span className="dim mono">{body.reason}</span>}
            </div>
            <button type="button" className="link-btn" onClick={() => onOpenBody(body.session_id)}>
              {t('team.member.viewTranscript')}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  if (entries.length === 0) return <EmptyState title={t('team.member.empty')} />;

  return (
    <ul className="team-body-history">
      {entries.map((body) => (
        <li className="team-body-history-item" key={body.session_id}>
          <div className="team-body-history-main">
            <span className="mono">{body.session_id}</span>
            <span className="dim">{t('team.member.epoch', { epoch: body.epoch })}</span>
            <span className="dim">
              {t('team.member.startedAt', { time: formatTimestamp(body.started_at) })}
            </span>
            <span className="dim">
              {t('team.member.retiredAt', { time: formatTimestamp(body.retired_at) })}
            </span>
          </div>
          <button type="button" className="link-btn" onClick={() => onOpenBody(body.session_id)}>
            {t('team.member.viewTranscript')}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MemberDetail({
  client,
  hasToken,
  epoch,
  tenantEpoch,
  teamId,
  memberId,
  bodyId,
  events,
  onBack,
  onBackToMember,
  onOpenSession,
  onOpenBody,
  initialDetail,
  initialSession,
  initialError,
}: MemberDetailProps) {
  const resource = useResource({
    load: () => client.getTeam(teamId, { limit: 1 }),
    enabled: hasToken,
    pollMs: 4_000,
    deps: [epoch, tenantEpoch, teamId],
    ...(initialDetail !== undefined ? { initialData: initialDetail } : {}),
  });

  // 回退历史只读事件；页面内同步派生，刷新后自然丢弃。
  const observedState = useMemo(() => {
    let state = createTeamEventState();
    for (const entry of events) {
      if (entry.seq <= state.lastAppliedSeq) continue;
      state = applyTeamEvent(state, { ...entry.event, seq: entry.seq }, teamId);
    }
    return state;
  }, [events, teamId]);

  const detail = resourceData(resource.state) ?? initialDetail;
  const member = useMemo(
    () => detail?.members.find((item: TeamMember) => item.agent_id === memberId),
    [detail, memberId],
  );
  const observed = useMemo(
    () => observedBodyHistory(observedState, memberId),
    [observedState, memberId],
  );
  // 单一真相源：服务端字段存在时完全忽略事件观察值。
  const history = useMemo(
    () => preferBodyHistory(serverBodyHistory(member), observed),
    [member, observed],
  );

  const error =
    resource.state.status === 'error'
      ? { message: resource.state.error, code: resource.state.code }
      : initialError;

  if (bodyId) {
    return (
      <BodyTranscript
        client={client}
        hasToken={hasToken}
        epoch={epoch}
        bodyId={bodyId}
        initialSession={initialSession}
        onBackToMember={onBackToMember}
      />
    );
  }

  if (!hasToken) {
    return (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  }

  if (!detail && error) {
    return error.code === 'not_found' ? (
      <NotEnabledState
        title={t('team.error.notEnabled')}
        reason={t('team.error.notEnabledReason')}
        hint={t('team.error.notEnabledHint')}
      />
    ) : (
      <ErrorState message={error.message} onRetry={resource.reload} />
    );
  }

  if (!detail) return <LoadingState rows={3} />;

  if (!member) {
    return (
      <EmptyState
        title={t('team.error.notFound')}
        action={<Button onClick={onBack}>{t('team.chat.backToList')}</Button>}
      />
    );
  }

  const status = memberStatus(member);
  const name = member.name?.trim() || shortAgentId(member.agent_id);
  const observedOnly = history.source === 'observed';

  return (
    <div className="team-member-detail">
      <header className="team-chat-head">
        <div className="team-chat-heading">
          <h1 className="team-chat-title">{name}</h1>
          <div className="team-chat-meta">
            <span className="mono">{member.agent_id}</span>
            <span
              role="img"
              className={`team-presence-dot ${member.presence}`}
              aria-label={
                member.presence === 'live' ? t('team.presence.live') : t('team.presence.gone')
              }
            />
            <StatusChip
              status={status.chipStatus}
              label={t(status.labelKey)}
              title={status.titleKey ? t(status.titleKey) : undefined}
            />
            <span className="dim">
              {t('team.member.visibility', { visibility: member.visibility })}
            </span>
          </div>
        </div>
        <div className="team-chat-actions">
          <Button onClick={onBack}>{t('breadcrumb.team.chat')}</Button>
        </div>
      </header>

      {error && <StaleNotice message={t('team.error.stale')} onRetry={resource.reload} />}

      <div className="team-member-scroll">
        <section className="team-body-card">
          <h2 className="section-title">{t('team.member.currentBody')}</h2>
          <dl className="team-body-meta">
            <div>
              <dt>epoch</dt>
              <dd className="mono">{member.epoch ?? '—'}</dd>
            </div>
            <div>
              <dt>session</dt>
              <dd className="mono">{member.session_id ?? '—'}</dd>
            </div>
            <div>
              <dt>state</dt>
              <dd>{t(status.labelKey)}</dd>
            </div>
            <div>
              <dt>presence</dt>
              <dd>
                {member.presence === 'live' ? t('team.presence.live') : t('team.presence.gone')}
              </dd>
            </div>
          </dl>
          <Button
            variant="primary"
            disabled={!member.session_id}
            onClick={() => {
              if (member.session_id) onOpenSession(member.session_id);
            }}
          >
            {t('team.member.currentSession')}
          </Button>
        </section>

        <section className="team-body-history-section">
          <h2 className="section-title">{t('team.member.retiredBodies')}</h2>
          {observedOnly && observed.length > 0 && (
            <p className="dim team-observed-note">{t('team.member.observedOnly')}</p>
          )}
          <BodyHistoryList
            entries={history.server}
            observed={history.observed}
            onOpenBody={onOpenBody}
          />
        </section>
      </div>
    </div>
  );
}
