import { EmptyState } from '../../components/States';
import { IconButton } from '../../components/Tooltip';
import { Badge, Icon } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { TeamBodyHistoryEntry, TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import type { ObservedBody } from '../../state/teams';

/**
 * 历史条目布局：左 = 会话序号（主）+ 完整 session id（次，mono 小字）；
 * 右 = 时间列（开始 / 退役）+ 打开 transcript 按钮。窄屏（≤680）整行折成
 * 纵向（team.css），时间列随之左对齐。
 */
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
          <li className="team-body-history-item tint-hover" key={body.session_id}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">
                  {t('team.member.sessionIndex', { n: body.epoch })}
                </span>
                {body.reason && <span className="font-mono text-xs text-muted">{body.reason}</span>}
              </div>
              <span className="truncate font-mono text-xs text-faint" title={body.session_id}>
                {body.session_id}
              </span>
            </div>
            <div className="team-body-history-meta flex flex-none flex-col items-end gap-0.5 text-xs text-muted tabular-nums">
              <span>
                {t('team.member.observedAt', { time: formatTimestamp(body.observed_at) })}
              </span>
            </div>
            <IconButton
              label={t('team.member.viewTranscript')}
              onClick={() => onOpenBody(body.session_id)}
            >
              <Icon name="transcript" />
            </IconButton>
          </li>
        ))}
      </ul>
    );
  }

  if (entries.length === 0) return <EmptyState title={t('team.member.empty')} />;

  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {entries.map((body) => (
        <li className="team-body-history-item tint-hover" key={body.session_id}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium text-ink">
              {t('team.member.sessionIndex', { n: body.epoch })}
            </span>
            <span className="truncate font-mono text-xs text-faint" title={body.session_id}>
              {body.session_id}
            </span>
          </div>
          <div className="team-body-history-meta flex flex-none flex-col items-end gap-0.5 text-xs text-muted tabular-nums">
            <span>{t('team.member.startedAt', { time: formatTimestamp(body.started_at) })}</span>
            <span>{t('team.member.retiredAt', { time: formatTimestamp(body.retired_at) })}</span>
          </div>
          <IconButton
            label={t('team.member.viewTranscript')}
            onClick={() => onOpenBody(body.session_id)}
          >
            <Icon name="transcript" />
          </IconButton>
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
 * 布局：与当前会话字段区以发丝线分组；行内沉底圆角块，序号主 / id 次。
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
    <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
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
              className="team-body-item flex items-center gap-3 rounded-md bg-sunken px-3 py-2 text-sm"
              key={sessionId || `body-${index}`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">
                    {body.epoch !== undefined
                      ? t('team.member.sessionIndex', { n: body.epoch })
                      : '—'}
                  </span>
                  {primary && <Badge className="text-muted">{t('team.member.primaryBadge')}</Badge>}
                </span>
                <span className="truncate font-mono text-xs text-faint" title={sessionId}>
                  {sessionId || '—'}
                </span>
              </div>
              {body.state && (
                <span className="flex-none font-mono text-xs text-muted">{body.state}</span>
              )}
              <IconButton
                label={t('team.member.openBody')}
                disabled={!sessionId}
                onClick={() => {
                  if (sessionId) onOpenSession(sessionId);
                }}
              >
                <Icon name="transcript" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
