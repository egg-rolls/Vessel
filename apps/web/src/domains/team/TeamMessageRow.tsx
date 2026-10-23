/**
 * Team 单条消息：human / agent 日志 / 成员回复 / 系统灰条。
 *
 * 系统消息只按 `system_event` 本地化；未知事件回退原始 `content`，
 * 不解析正文里的 from / to / epoch。回复与日志都按 `message_id` 由上层去重。
 */
import { Markdown } from '../../components/Markdown';
import { StatusChip } from '../../components/StatusChip';
import { formatClock } from '../../format';
import type { TeamDelivery, TeamMessage } from '../../gateway/types';
import { t } from '../../i18n';

export interface TeamMessageView extends TeamMessage {
  sendStatus?: 'sending' | 'sent' | 'failed';
  sendError?: string;
  deliveries?: readonly TeamDelivery[];
}

const SYSTEM_KEYS: Record<string, string> = {
  join: 'team.system.join',
  leave: 'team.system.leave',
  archive: 'team.system.archive',
  rotate: 'team.system.rotate',
};

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function MessageTime({ ts }: { ts: number }) {
  const clock = formatClock(ts);
  if (!clock) return null;
  const iso = new Date(ts).toISOString();
  return (
    <time className="team-message-time" dateTime={iso}>
      {clock}
    </time>
  );
}

function DeliveryNotes({ deliveries }: { deliveries: readonly TeamDelivery[] }) {
  if (deliveries.length === 0) return null;
  const queued = deliveries.filter((delivery) => delivery.status === 'queued');
  const failures = deliveries.filter((delivery) => delivery.status !== 'queued');
  return (
    <>
      {queued.map((delivery) => (
        <span
          className="team-delivery-queued"
          key={`queued-${delivery.agent_id}`}
          role="status"
          aria-label={t('team.a11y.deliveryQueued')}
        >
          ○{' '}
          {delivery.resolution === 'rotating'
            ? t('team.delivery.queuedRotating')
            : t('team.delivery.queued')}
          <span className="mono"> · {delivery.agent_id}</span>
        </span>
      ))}
      {failures.map((delivery, index) => (
        <div
          className="team-delivery-error"
          key={`failed-${delivery.agent_id}-${delivery.code ?? delivery.status}`}
          role={index === 0 ? 'alert' : 'status'}
        >
          <StatusChip
            status="failed"
            label={
              delivery.status === 'rejected'
                ? t('team.delivery.rejected')
                : t('team.delivery.error')
            }
          />
          <span className="mono">{delivery.code ?? delivery.status}</span>
          <span className="mono">{delivery.agent_id}</span>
          {delivery.reason && <span>{truncate(delivery.reason, 160)}</span>}
        </div>
      ))}
    </>
  );
}

function SystemNotice({ message, senderLabel }: { message: TeamMessage; senderLabel?: string }) {
  const key = message.system_event ? SYSTEM_KEYS[message.system_event] : undefined;
  const text = key
    ? t(key, { name: senderLabel ?? message.from })
    : message.content || t('team.system.unknown');
  return (
    <div className="team-notice" role="status">
      <span className="team-notice-tag">{t('team.message.systemTag')}</span>
      <span>{text}</span>
    </div>
  );
}

export function TeamMessageRow({
  message,
  senderLabel,
  canViewSession,
  onViewSession,
  onRetry,
}: {
  message: TeamMessageView;
  senderLabel?: string;
  canViewSession?: boolean;
  onViewSession?: () => void;
  onRetry?: () => void;
}) {
  if (message.kind === 'system') {
    return <SystemNotice message={message} senderLabel={senderLabel} />;
  }

  const isReply = message.kind === 'reply';
  // 只有 canonical Web 记录固定 `from='human'`。不能按 roster 反推 human：
  // roster 只含 present，left / private agent 的日志会因此被误标成“我”。
  const isHuman = message.from === 'human';
  const isAgent = !isHuman && !isReply;
  const statusClass =
    message.sendStatus === 'failed'
      ? ' team-message-failed'
      : message.sendStatus === 'sending'
        ? ' team-message-pending'
        : '';

  return (
    <div
      className={`team-message ${isHuman ? 'team-message-human team-message-self' : 'team-message-agent'}${statusClass}`}
      data-kind={message.kind}
    >
      <div className="team-message-meta">
        <span className="team-message-sender">
          {isHuman ? t('team.message.you') : (senderLabel ?? message.from)}
        </span>
        {isAgent && <span className="team-message-tag">{t('team.message.agentTag')}</span>}
        {isReply && <span className="team-message-tag">{t('team.message.replyTag')}</span>}
        <MessageTime ts={message.ts} />
        {message.sendStatus === 'sending' && (
          <span className="team-message-sending dim">{t('team.composer.sending')}</span>
        )}
      </div>

      <div className="team-message-bubble">
        <Markdown className="team-message-text" text={message.content} />
      </div>

      {(isReply || isAgent) && canViewSession && onViewSession && (
        <button type="button" className="link-btn team-message-view-body" onClick={onViewSession}>
          {t('team.message.viewBody')}
        </button>
      )}

      {message.deliveries && <DeliveryNotes deliveries={message.deliveries} />}

      {message.sendStatus === 'failed' && (
        <div className="team-delivery-error team-send-error" role="alert">
          <StatusChip status="failed" label={t('team.delivery.failed')} />
          {message.sendError && <span className="mono">{truncate(message.sendError, 160)}</span>}
          {onRetry && (
            <button type="button" className="link-btn" onClick={onRetry}>
              {t('team.delivery.retry')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
