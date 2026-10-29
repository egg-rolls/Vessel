/**
 * 成员详情：当前 Body + 已退役 Body + 旧 Body 只读 transcript。
 *
 * Body 历史优先服务端 `member.body_history`；只有字段缺失时才使用
 * `agent.rotated / agent.retired` 的本次页面观察值，并明确标注。
 * 不提供配置 / rotate / close 操作。
 */
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { Markdown } from '../../components/Markdown';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useOptionalToast } from '../../components/ToastProvider';
import { Badge, Button, Select } from '../../components/ui';
import { formatClock, formatTimestamp, localDayKey, localDayLabel } from '../../format';
import type {
  AgentSummary,
  AgentUpdateInput,
  Message,
  SessionDetail,
  TeamBodyHistoryEntry,
  TeamDetail,
  TeamMember,
} from '../../gateway/types';
import { t } from '../../i18n';
import type { StoredEvent } from '../../state/events';
import {
  isRuntimeMessageVisible,
  runtimeMessageKind,
  useRuntimeVisibility,
} from '../../state/runtime-visibility';
import {
  applyTeamEvent,
  createTeamEventState,
  type ObservedBody,
  observedBodyHistory,
  preferBodyHistory,
  serverBodyHistory,
} from '../../state/teams';
import { resourceData, useResource } from '../../state/useResource';
import { teamDetailKey, teamListData, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { memberStatus } from './member-status';
import { shortAgentId } from './mention';
import {
  conversionActions,
  conversionError,
  type RoleConversion,
  roleLabelKey,
  roleOf,
} from './role';
import type { TeamChatClient } from './TeamChat';

export interface MemberDetailClient extends TeamChatClient {
  getSession(sessionId: string): Promise<SessionDetail>;
  updateAgent(input: AgentUpdateInput): Promise<AgentSummary>;
}

export interface MemberDetailProps {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  tenantEpoch: number;
  teamId: string;
  memberId: string;
  /** Store key discriminator for multi-node Teams; defaults for tests / preview. */
  nodeKey?: string;
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
  const { visibility } = useRuntimeVisibility();
  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  // 只读会话消息没有稳定 id：用局部序号做 key，稳定且不受排序影响。
  let keySeq = 0;
  for (const message of messages) {
    // Runtime context (`vessel:*`) is model-only; hide it unless the user opts in.
    const kind = runtimeMessageKind(message);
    if (kind !== undefined && !isRuntimeMessageVisible(visibility, kind)) continue;
    const key = `message-${keySeq++}`;
    const ts = message.timestamp;
    const day = ts !== undefined ? localDayKey(ts) : null;
    if (day && day !== lastDay) {
      nodes.push(
        <div className="day-divider mt-1.5 mb-0.5" key={`day-${day}`}>
          <span>{localDayLabel(ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (message.role === 'system') {
      nodes.push(
        <div
          className="mx-auto my-0.5 max-w-180 rounded-r-sm border-l-2 border-l-line-strong bg-sunken px-3 py-1.25 text-center text-sm text-muted"
          key={key}
          role="status"
        >
          <span className="mr-1.5 font-mono text-2xs uppercase text-faint">
            {t('team.message.systemTag')}
          </span>
          <span>{message.content}</span>
        </div>,
      );
      continue;
    }
    nodes.push(
      <div className="flex flex-col gap-1" key={key}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
          <span className="font-medium text-muted">{message.name || message.role}</span>
          {ts !== undefined && (
            <time className="font-mono tabular-nums" dateTime={new Date(ts).toISOString()}>
              {formatClock(ts)}
            </time>
          )}
        </div>
        {message.role === 'tool' ? (
          <pre className="m-0 max-w-180 rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {message.content}
          </pre>
        ) : (
          <div className="team-message-bubble">
            <Markdown className="text-base leading-relaxed wrap-anywhere" text={message.content} />
          </div>
        )}
      </div>,
    );
  }
  return <div className="mx-auto flex w-full max-w-180 flex-col gap-3">{nodes}</div>;
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
    <div className="team-body-view flex min-h-0 min-w-0 flex-col">
      <header className="team-chat-head">
        <div className="min-w-0">
          <h1 className="font-serif text-title font-semibold wrap-anywhere">
            {t('team.member.title')}
          </h1>
          <div className="mt-1.25 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono">{bodyId}</span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1.5">
          <Button onClick={onBackToMember}>{t('breadcrumb.team.member')}</Button>
        </div>
      </header>
      <div className="team-transcript-scroll pt-4">
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
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {observed.map((body) => (
          <li className="team-body-history-item" key={body.session_id}>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="font-mono">{body.session_id}</span>
              <span className="text-muted tabular-nums">
                {t('team.member.epoch', { epoch: body.epoch })}
              </span>
              <span className="text-muted tabular-nums">
                {t('team.member.observedAt', { time: formatTimestamp(body.observed_at) })}
              </span>
              {body.reason && <span className="font-mono text-muted">{body.reason}</span>}
            </div>
            <Button variant="link" onClick={() => onOpenBody(body.session_id)}>
              {t('team.member.viewTranscript')}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  if (entries.length === 0) return <EmptyState title={t('team.member.empty')} />;

  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {entries.map((body) => (
        <li className="team-body-history-item" key={body.session_id}>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="font-mono">{body.session_id}</span>
            <span className="text-muted tabular-nums">
              {t('team.member.epoch', { epoch: body.epoch })}
            </span>
            <span className="text-muted tabular-nums">
              {t('team.member.startedAt', { time: formatTimestamp(body.started_at) })}
            </span>
            <span className="text-muted tabular-nums">
              {t('team.member.retiredAt', { time: formatTimestamp(body.retired_at) })}
            </span>
          </div>
          <Button variant="link" onClick={() => onOpenBody(body.session_id)}>
            {t('team.member.viewTranscript')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 多 Body 列表（0.27）。
 *
 * `member.bodies` 是服务端 live body 列表；字段缺省时本组件不渲染，
 * 由「当前 Body」卡片上的单 body 信息（`session_id` / `epoch` / 打开按钮）退化承担。
 */
function LiveBodiesList({
  member,
  onOpenSession,
}: {
  member: TeamMember;
  onOpenSession: (sessionId: string) => void;
}) {
  const bodies = (member.bodies ?? []).filter((body) => body.retired_at === undefined);
  if (bodies.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="m-0 text-sm font-semibold text-muted">
        {t('team.member.liveBodies', { count: bodies.length })}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {bodies.map((body, index) => {
          const sessionId = body.session_id ?? body.body_id ?? '';
          // `primary` 字段缺失时按 agent 的 `session_id`（primary body）判断。
          const primary = body.primary ?? (sessionId.length > 0 && sessionId === member.session_id);
          return (
            <li
              className="team-body-item flex flex-wrap items-center gap-2 text-sm"
              key={sessionId || `body-${index}`}
            >
              <span className="font-mono">{sessionId || '—'}</span>
              {primary && <Badge>{t('team.member.primaryBadge')}</Badge>}
              {body.epoch !== undefined && (
                <span className="text-muted tabular-nums">
                  {t('team.member.epoch', { epoch: body.epoch })}
                </span>
              )}
              {body.state && <span className="font-mono text-muted">{body.state}</span>}
              <Button
                variant="link"
                disabled={!sessionId}
                title={t('team.member.openBody')}
                onClick={() => {
                  if (sessionId) onOpenSession(sessionId);
                }}
              >
                {t('team.member.openBody')}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const CONVERSION_LABEL_KEYS: Record<RoleConversion, string> = {
  member: 'team.role.toMember',
  temporary: 'team.role.toTemporary',
};

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function RoleConversionSection({
  member,
  teamId,
  nodeKey,
  client,
  hasToken,
  onConverted,
}: {
  member: TeamMember;
  teamId: string;
  nodeKey: string;
  client: MemberDetailClient;
  hasToken: boolean;
  onConverted: () => void;
}) {
  const toast = useOptionalToast();
  const role = roleOf(member);
  const actions = conversionActions(role);
  const teamList = useTeamStore((state) => state.lists[nodeKey]);
  const teams = teamListData(teamList)?.teams ?? [];
  const teamOptions = teams.filter((team) => team.archived_at === undefined);
  const [targetTeamId, setTargetTeamId] = useState(teamId);
  const [busy, setBusy] = useState<RoleConversion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const needsTeam = actions.includes('member');
  const canWrite = hasToken && !denied;

  const convert = async (target: RoleConversion) => {
    if (!canWrite || busy) return;
    const invalid = conversionError(target, targetTeamId);
    if (invalid) {
      setError(t('team.role.memberRequiresTeam'));
      return;
    }
    setBusy(target);
    setError(null);
    const input: AgentUpdateInput = { agent_id: member.agent_id, role: target };
    if (target === 'member') input.team_id = targetTeamId.trim();
    try {
      await client.updateAgent(input);
      toast?.success(
        t('team.role.success', {
          name: member.name?.trim() || shortAgentId(member.agent_id),
          role: t(roleLabelKey(target)),
        }),
      );
      onConverted();
    } catch (caught) {
      if (errorCodeOf(caught) === 'forbidden') {
        setDenied(true);
        setError(t('team.role.forbidden'));
      } else {
        const detail = caught instanceof Error ? caught.message : String(caught);
        setError(`${t('team.role.failed')}: ${detail}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-md font-semibold text-ink">{t('team.role.convert')}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{t('team.role.label')}</span>
        <Badge>{t(roleLabelKey(role))}</Badge>
      </div>
      {needsTeam && (
        <label
          className="flex flex-wrap items-center gap-2 text-sm text-muted"
          htmlFor="member-role-team"
        >
          <span>{t('team.role.memberTeam')}</span>
          <Select
            id="member-role-team"
            value={targetTeamId}
            onChange={(event) => setTargetTeamId(event.target.value)}
            aria-label={t('team.role.memberTeam')}
            disabled={!canWrite || busy !== null}
          >
            {teamOptions.length === 0 && (
              <option value={teamId}>
                {teams.find((team) => team.team_id === teamId)?.name || teamId}
              </option>
            )}
            {teamOptions.map((team) => (
              <option key={team.team_id} value={team.team_id}>
                {team.name || team.team_id}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((target) => (
          <Button
            key={target}
            size="small"
            disabled={!canWrite || busy !== null}
            onClick={() => {
              void convert(target);
            }}
          >
            {busy === target ? t('team.role.busy') : t(CONVERSION_LABEL_KEYS[target])}
          </Button>
        ))}
      </div>
      {!hasToken && <p className="m-0 text-xs text-muted">{t('common.writesDisabled')}</p>}
      {error && (
        <p className="m-0 rounded-sm bg-danger-soft px-2.5 py-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function MemberDetail({
  client,
  hasToken,
  epoch,
  tenantEpoch,
  teamId,
  memberId,
  nodeKey = 'local',
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
  const storeKey = teamDetailKey(nodeKey, teamId, 'member');
  const detailState = useTeamStore((state) => state.details[storeKey]);
  const loadDetail = useTeamStore((state) => state.loadDetail);
  const reload = () => {
    void loadDetail(nodeKey, teamId, client, { limit: 1 }, 'member');
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // Team 栏卡片的 Refresh 走全局刷新信号。
  const refreshFromSignal = useCallback(() => {
    reloadRef.current();
  }, []);
  useRefreshSignal(refreshFromSignal);
  usePolledAction(
    () => {
      void loadDetail(nodeKey, teamId, client, { limit: 1 }, 'member');
    },
    { enabled: hasToken, pollMs: 4_000, deps: [epoch, tenantEpoch, teamId, nodeKey] },
  );

  // 回退历史只读事件；页面内同步派生，刷新后自然丢弃。
  // `agent.rotated` / `agent.retired` 是 agent 域生命周期事件，仍带 `team_id`。
  const observedState = useMemo(() => {
    let state = createTeamEventState();
    for (const entry of events) {
      if (entry.seq <= state.lastAppliedSeq) continue;
      state = applyTeamEvent(state, { ...entry.event, seq: entry.seq }, teamId);
    }
    return state;
  }, [events, teamId]);

  const detail = resourceData(detailState) ?? initialDetail;
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
    detailState?.status === 'error'
      ? { message: detailState.error, code: detailState.code }
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
      <ErrorState message={error.message} onRetry={reload} />
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
    <div className="flex min-h-0 min-w-0 flex-col">
      <header className="team-chat-head">
        <div className="min-w-0">
          <h1 className="font-serif text-title font-semibold wrap-anywhere">{name}</h1>
          <div className="mt-1.25 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono">{member.agent_id}</span>
            <span
              role="img"
              className={`size-1.5 flex-none rounded-full ${
                member.presence === 'live' ? 'bg-success' : 'border border-faint bg-transparent'
              }`}
              aria-label={
                member.presence === 'live' ? t('team.presence.live') : t('team.presence.gone')
              }
            />
            <StatusChip
              status={status.chipStatus}
              label={t(status.labelKey)}
              title={status.titleKey ? t(status.titleKey) : undefined}
            />
            <Badge>{t(roleLabelKey(roleOf(member)))}</Badge>
            <span className="text-muted">
              {t('team.member.visibility', { visibility: member.visibility })}
            </span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1.5">
          <Button onClick={onBack}>{t('breadcrumb.team.chat')}</Button>
        </div>
      </header>

      {error && <StaleNotice message={t('team.error.stale')} onRetry={reload} />}

      <div className="mx-auto flex w-full max-w-225 flex-col gap-5 px-8 py-5 pb-8 max-compact:px-4">
        <section className="team-body-card rounded-md border border-line bg-surface p-4">
          <h2 className="text-md font-semibold text-ink">{t('team.member.currentBody')}</h2>
          <dl className="team-body-meta">
            <div>
              <dt>epoch</dt>
              <dd className="font-mono tabular-nums">{member.epoch ?? '—'}</dd>
            </div>
            <div>
              <dt>session</dt>
              <dd className="font-mono">{member.session_id ?? '—'}</dd>
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
          <LiveBodiesList member={member} onOpenSession={onOpenSession} />
        </section>

        <RoleConversionSection
          key={`${nodeKey}:${teamId}:${member.agent_id}`}
          member={member}
          teamId={teamId}
          nodeKey={nodeKey}
          client={client}
          hasToken={hasToken}
          onConverted={reload}
        />

        <section className="flex flex-col gap-2">
          <h2 className="text-md font-semibold text-ink">{t('team.member.retiredBodies')}</h2>
          {observedOnly && observed.length > 0 && (
            <p className="m-0 text-xs">{t('team.member.observedOnly')}</p>
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
