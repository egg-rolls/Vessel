import { EmptyState } from '../../components/States';
import { Badge, Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { TeamBodyHistoryEntry, TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import type { ObservedBody } from '../../state/teams';

export function BodyHistoryList({
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
                {t('team.member.sessionIndex', { n: body.epoch })}
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
              {t('team.member.sessionIndex', { n: body.epoch })}
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
export function LiveBodiesList({
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
                  {t('team.member.sessionIndex', { n: body.epoch })}
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
