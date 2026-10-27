/**
 * Team 单条消息：human / agent 日志 / 成员回复 / 系统灰条。
 *
 * 系统消息只按 `system_event` 本地化；未知事件回退原始 `content`，
 * 不解析正文里的 from / to / epoch。回复与日志都按 `message_id` 由上层去重。
 */
import { Markdown } from '../../components/Markdown';
import { StatusChip } from '../../components/StatusChip';
import { useOptionalToast } from '../../components/ToastProvider';
import { Badge, Button } from '../../components/ui';
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
  fork: 'team.system.fork',
};

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function MessageTime({ ts }: { ts: number }) {
  const clock = formatClock(ts);
  if (!clock) return null;
  const iso = new Date(ts).toISOString();
  return (
    <time className="font-mono tabular-nums" dateTime={iso}>
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
          className="team-delivery-queued self-start font-mono text-2xs text-faint"
          key={`queued-${delivery.agent_id}`}
          role="status"
          aria-label={t('team.a11y.deliveryQueued')}
        >
          ○{' '}
          {delivery.resolution === 'rotating'
            ? t('team.delivery.queuedRotating')
            : delivery.resolution === 'forked'
              ? t('team.delivery.queuedForked')
              : t('team.delivery.queued')}
          <span className="font-mono"> · {delivery.agent_id}</span>
        </span>
      ))}
      {failures.map((delivery, index) => (
        <div
          className="team-delivery-error self-start flex max-w-180 flex-wrap items-center gap-1.5 rounded-r-sm border-l-2 border-danger bg-danger-soft px-2.5 py-1.25 text-xs text-danger"
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
          <span className="font-mono text-xs">{delivery.code ?? delivery.status}</span>
          <span className="font-mono text-xs">{delivery.agent_id}</span>
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
    <div
      className="mx-auto my-0.5 max-w-180 rounded-r-sm border-l-2 border-l-line-strong bg-sunken px-3 py-1.25 text-center text-sm text-muted"
      role="status"
    >
      <span className="mr-1.5 font-mono text-2xs uppercase text-faint">
        {t('team.message.systemTag')}
      </span>
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
  // 钩子必须在 system 早退之前调用，保证同一实例的 hook 顺序稳定。
  const toast = useOptionalToast();

  if (message.kind === 'system') {
    return <SystemNotice message={message} senderLabel={senderLabel} />;
  }

  const federationFrom = message.federation?.from_addr;
  const copyFederationAddress = () => {
    if (!federationFrom) return;
    try {
      void navigator.clipboard?.writeText(federationFrom).catch(() => undefined);
    } catch {
      // clipboard 不可用（非安全上下文 / 权限拒绝）：仍给出回复指引。
    }
    toast?.info(t('team.federation.replyHint', { addr: federationFrom }));
  };

  const isReply = message.kind === 'reply';
  // 只有 canonical Web 记录固定 `from='human'`。不能按 roster 反推 human：
  // roster 只含 present，left / private agent 的日志会因此被误标成“我”。
  const isHuman = message.from === 'human';
  const isAgent = !isHuman && !isReply;
  // 人类定向消息：出站 / 入站都用 `to: ['human']` 落日志（federation 入站的 human
  // 分支与本机路径一致）。只读日志字段，不按内容猜。
  const asksHuman = !isHuman && Array.isArray(message.to) && message.to.includes('human');
  const statusClass =
    message.sendStatus === 'failed'
      ? ' team-message-failed'
      : message.sendStatus === 'sending'
        ? ' opacity-70'
        : '';

  return (
    <div
      className={`flex max-w-full flex-col gap-1 ${isHuman ? 'team-message-self' : 'team-message-agent'}${statusClass}`}
      data-kind={message.kind}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <span className="font-medium text-muted">
          {isHuman ? t('team.message.you') : (senderLabel ?? message.from)}
        </span>
        {isAgent && (
          <span className="rounded-full border border-line-strong px-1.25 font-mono text-2xs text-muted">
            {t('team.message.agentTag')}
          </span>
        )}
        {isReply && (
          <span className="rounded-full border border-line-strong px-1.25 font-mono text-2xs text-muted">
            {t('team.message.replyTag')}
          </span>
        )}
        {asksHuman && (
          <Badge tone="accent" title={t('team.message.toHumanHint')}>
            {t('team.message.toHumanTag')}
          </Badge>
        )}
        {federationFrom && (
          <span className="max-w-80 truncate font-mono text-muted" title={federationFrom}>
            {t('team.federation.from')} {federationFrom}
          </span>
        )}
        <MessageTime ts={message.ts} />
        {message.sendStatus === 'sending' && (
          <span className="text-muted">{t('team.composer.sending')}</span>
        )}
      </div>

      <div className="team-message-bubble">
        <Markdown className="text-base leading-relaxed wrap-anywhere" text={message.content} />
      </div>

      {(isReply || isAgent) && canViewSession && onViewSession && (
        <Button variant="link" className="self-start text-xs" onClick={onViewSession}>
          {t('team.message.viewBody')}
        </Button>
      )}

      {federationFrom && (
        <Button variant="link" className="self-start text-xs" onClick={copyFederationAddress}>
          {t('team.federation.reply')}
        </Button>
      )}

      {message.deliveries && <DeliveryNotes deliveries={message.deliveries} />}

      {message.sendStatus === 'failed' && (
        <div
          className="team-delivery-error self-start flex max-w-180 flex-wrap items-center gap-1.5 rounded-r-sm border-l-2 border-danger bg-danger-soft px-2.5 py-1.25 text-xs text-danger"
          role="alert"
        >
          <StatusChip status="failed" label={t('team.delivery.failed')} />
          {message.sendError && (
            <span className="font-mono text-xs">{truncate(message.sendError, 160)}</span>
          )}
          {onRetry && (
            <Button variant="link" onClick={onRetry}>
              {t('team.delivery.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
