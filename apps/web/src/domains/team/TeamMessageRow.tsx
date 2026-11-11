/**
 * Team 单条消息：human / agent 日志 / 成员回复 / 系统灰条。
 *
 * 系统消息只按 `system_event` 本地化；未知事件回退原始 `content`，
 * 不解析正文里的 from / to / epoch。回复与日志都按 `message_id` 由上层去重。
 */
import { Markdown } from '../../components/Markdown';
import { StatusChip } from '../../components/StatusChip';
import { useOptionalToast } from '../../components/ToastProvider';
import {
  Badge,
  type MessageAction,
  MessageActions,
  MessageFold,
  useMessageCopy,
} from '../../components/ui';
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
  create: 'team.system.create',
  // 旧日志只读：0.39 起新写 `create`，不再写 `fork`。
  fork: 'team.system.fork',
  retract: 'team.system.retract',
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
            : delivery.resolution === 'created'
              ? t('team.delivery.queuedCreated')
              : delivery.resolution === 'forked'
                ? // 旧日志只读：0.39 起新写 `created`。
                  t('team.delivery.queuedForked')
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
  // 撤回 tombstone 的 `from` 固定为 human（`to` / `mentions` 为空），显示“我/你”。
  const rawName = senderLabel ?? message.from;
  const name = rawName === 'human' ? t('team.message.you') : rawName;
  const text = key ? t(key, { name }) : message.content || t('team.system.unknown');
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
  recipientLabels,
  entering = false,
  canViewSession,
  onViewSession,
  onRetry,
  onEdit,
  onResend,
  onRetract,
}: {
  message: TeamMessageView;
  senderLabel?: string;
  /**
   * 已解析好的 agent 收件人显示名（`to` 经 `TeamTranscript` 过滤 / 去重后逐个查 roster）。
   * 空数组 = 不显示箭头：广播、成员回复、发给人类、或目标不是 agent。
   */
  recipientLabels?: readonly string[];
  /**
   * 本帧才追加进来的行：挂 `.msg-enter` 播一次入场（会话页同一套 class / 同一个判定，
   * 见 `TeamTranscript` 与 `components/ui/useEnteringItemKeys.ts`）。
   */
  entering?: boolean;
  canViewSession?: boolean;
  onViewSession?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onResend?: () => void;
  onRetract?: () => void;
}) {
  // 钩子必须在 system 早退之前调用，保证同一实例的 hook 顺序稳定。
  const toast = useOptionalToast();
  const copy = useMessageCopy(t('common.copied'));

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
  const toLabels = recipientLabels ?? [];
  const toExtra = toLabels.length - 1;
  const statusClass =
    message.sendStatus === 'failed'
      ? ' team-message-failed'
      : message.sendStatus === 'sending'
        ? ' opacity-70'
        : '';

  // 已落盘的人类消息才有 edit / resend / retract；本地 failed 只保留 retry。
  const persisted = message.sendStatus === undefined || message.sendStatus === 'sent';
  const hasContent = message.content.trim().length > 0;

  // 所有操作收进同一行：hover / focus 时整组显现，不再各自堆叠。
  const actions: MessageAction[] = [];
  if (hasContent && message.sendStatus !== 'sending') {
    actions.push({ id: 'copy', label: t('common.copy'), onSelect: () => copy(message.content) });
  }
  if (isHuman && persisted) {
    if (hasContent && onEdit) {
      actions.push({ id: 'edit', label: t('team.message.edit'), onSelect: onEdit });
    }
    if (hasContent && onResend) {
      actions.push({ id: 'resend', label: t('team.message.resend'), onSelect: onResend });
    }
    if (onRetract) {
      actions.push({ id: 'retract', label: t('team.message.retract'), onSelect: onRetract });
    }
  }
  if ((isReply || isAgent) && canViewSession && onViewSession) {
    actions.push({
      id: 'transcript',
      label: t('team.message.viewBody'),
      onSelect: onViewSession,
    });
  }
  if (federationFrom) {
    actions.push({
      id: 'reply',
      label: t('team.federation.reply'),
      onSelect: copyFederationAddress,
    });
  }
  // retry 只服务于本地未落盘的人类发送；agent / reply 永不出现。
  if (isHuman && message.sendStatus === 'failed' && onRetry) {
    actions.push({ id: 'retry', label: t('team.delivery.retry'), onSelect: onRetry });
  }

  return (
    <div
      className={`group mx-auto flex w-full max-w-[var(--chat-content-w,860px)] flex-col gap-1 ${isHuman ? 'team-message-self' : 'team-message-agent'}${statusClass}${entering ? ' msg-enter' : ''}`}
      data-kind={message.kind}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <span className="font-medium text-muted">
          {isHuman ? t('team.message.you') : (senderLabel ?? message.from)}
        </span>
        {/* agent 日志的「发给谁」：只在 `to` 有 agent 目标时出现（人类 / 广播 / 回复不显示）。
            多目标显示第一个 + 「+N」，完整名单在 title 里；箭头与 +N 都是符号，不走 i18n。 */}
        {toLabels.length > 0 && (
          <span className="flex items-center gap-1" title={toLabels.join(', ')}>
            <span aria-hidden="true">→</span>
            <span className="font-medium text-muted">{toLabels[0]}</span>
            {toExtra > 0 && <span className="font-mono text-2xs">+{toExtra}</span>}
          </span>
        )}
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
        {/* 折叠与会话页同一套组件 / 阈值（`.msg-fold*`）：人发与 agent 回复都折。 */}
        <MessageFold>
          <Markdown className="text-base leading-relaxed wrap-anywhere" text={message.content} />
        </MessageFold>
      </div>

      <MessageActions className={isHuman ? 'self-end' : 'self-start'} actions={actions} />

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
        </div>
      )}
    </div>
  );
}
