/**
 * 成员详情：当前 Body + 已退役 Body + 旧 Body 只读 transcript。
 *
 * 本组件**不渲染标题栏**：身份/作用域/状态由调用方（`AgentDetailView` 的
 * `EntityHeader`）负责，这里只负责 Detail 槽与 Body 历史。
 *
 * Body 历史优先服务端 `member.body_history`；只有字段缺失时才使用
 * `agent.rotated / agent.retired` 的本次页面观察值，并明确标注。
 * 提供需确认的新建 session（`sessions.create` 无来源）；不提供配置 / close 操作。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyButton } from '../../components/CopyButton';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, KeyValueList } from '../../components/ui';
import type { TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import {
  applyTeamEvent,
  createTeamEventState,
  observedBodyHistory,
  preferBodyHistory,
  serverBodyHistory,
} from '../../state/teams';
import { resourceData } from '../../state/useResource';
import { teamDetailKey, useTeamStore } from '../../stores/teamStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { BodyHistoryList, LiveBodiesList } from './BodyHistory';
import type { MemberDetailProps } from './member-detail-types';
import { memberStatus } from './member-status';
import { shortAgentId } from './mention';
import { RoleConversionSection } from './RoleConversionSection';

export type { MemberDetailClient, MemberDetailProps } from './member-detail-types';

/** `sessions.create` 的常见失败码 → 可读文案；未知错误原样返回。 */
function createErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'not_found' || code === 'not_visible') {
    return t('team.member.rotate.error.notFound');
  }
  // 源 / 目标被占用、Team 冻结或满员、agent 已关闭：统一 conflict。
  if (code === 'conflict') return t('team.member.rotate.error.conflict');
  if (code === 'invalid_params') return t('team.member.rotate.error.invalid');
  if (code === 'quota_exceeded') return t('team.member.rotate.error.quota');
  return error instanceof Error ? error.message : String(error);
}

export function MemberDetail({
  client,
  hasToken,
  epoch,
  tenantEpoch,
  teamId,
  memberId,
  nodeKey = 'local',
  events,
  onBack,
  onOpenSession,
  onOpenBody,
  initialDetail,
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

  const toast = useToast();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [startupPrompt, setStartupPrompt] = useState('');
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const error =
    detailState?.status === 'error'
      ? { message: detailState.error, code: detailState.code }
      : initialError;

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

  const openRotate = () => {
    setStartupPrompt(t('team.member.rotate.defaultPrompt', { name }));
    setRotateError(null);
    setRotateOpen(true);
  };

  const submitRotate = async () => {
    const prompt = startupPrompt.trim();
    if (!prompt || rotating) return;
    setRotating(true);
    setRotateError(null);
    try {
      await client.createSession({ agent_id: member.agent_id, startup_prompt: prompt });
      toast.success(t('team.member.rotate.success', { name }));
      setRotateOpen(false);
      reload();
      // 群聊 / 团队详情共享同一 server snapshot，新 session 后一并刷新。
      void loadDetail(nodeKey, teamId, client, { limit: 1 }, 'chat');
    } catch (error) {
      setRotateError(createErrorMessage(error));
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {error && <StaleNotice message={t('team.error.stale')} onRetry={reload} />}

      <div className="flex w-full flex-col gap-5">
        <section className="team-body-card rounded-md border border-line bg-surface p-4">
          <h2 className="text-md font-semibold text-ink">{t('team.member.currentBody')}</h2>
          {/* Detail 槽：id / 会话 / 状态 / 可见性等事实的唯一渲染点（DESIGN-0.33.0 §1）。 */}
          <KeyValueList
            items={[
              {
                key: 'sessionNumber',
                label: t('team.member.sessionNumber'),
                value: (
                  <span className="font-mono tabular-nums">
                    {member.epoch !== undefined
                      ? t('team.member.sessionIndex', { n: member.epoch })
                      : '—'}
                  </span>
                ),
              },
              {
                key: 'session',
                label: t('agents.detail.session'),
                value: <span className="font-mono">{member.session_id ?? '—'}</span>,
              },
              {
                key: 'state',
                label: t('agents.filter.state'),
                value: t(status.labelKey),
              },
              {
                key: 'presence',
                label: t('agents.filter.presence'),
                value:
                  member.presence === 'live' ? t('team.presence.live') : t('team.presence.gone'),
              },
              {
                key: 'agentId',
                label: t('agents.detail.agentId'),
                value: (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono">{member.agent_id}</span>
                    <CopyButton text={member.agent_id} />
                  </span>
                ),
              },
              {
                key: 'visibility',
                label: t('agents.detail.visibility'),
                value: <span className="font-mono">{member.visibility}</span>,
              },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!member.session_id}
              onClick={() => {
                if (member.session_id) onOpenSession(member.session_id);
              }}
            >
              {t('team.member.currentSession')}
            </Button>
            <Button onClick={openRotate}>{t('team.member.rotate.open')}</Button>
          </div>
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

      {rotateOpen && (
        <ConfirmDialog
          title={t('team.member.rotate.title')}
          body={
            <>
              <p className="m-0">{t('team.member.rotate.description', { name })}</p>
              <label className="flex flex-col gap-1.5" htmlFor="rotate-startup-prompt">
                <span className="text-faint">{t('team.member.rotate.startupLabel')}</span>
                <textarea
                  id="rotate-startup-prompt"
                  className="min-h-28 w-full rounded-md border border-line bg-surface p-2.5 font-mono text-sm leading-relaxed text-ink"
                  value={startupPrompt}
                  disabled={rotating}
                  onChange={(event) => setStartupPrompt(event.target.value)}
                />
              </label>
              {rotateError && <p className="m-0 text-danger">{rotateError}</p>}
            </>
          }
          confirmLabel={t('team.member.rotate.confirm')}
          busy={rotating}
          confirmDisabled={startupPrompt.trim().length === 0}
          onConfirm={() => void submitRotate()}
          onCancel={() => {
            if (!rotating) setRotateOpen(false);
          }}
        />
      )}
    </div>
  );
}
