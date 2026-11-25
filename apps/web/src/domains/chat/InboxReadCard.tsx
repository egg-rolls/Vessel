/**
 * 「收件箱取走」消息卡（P1-A，症状②的可见承接）。
 *
 * 被 `inbox read` 消费的 agent / system 消息：从 inbox 消失、又不成为 run input，
 * 时间线以前没有任何承接（audit §3 主因）。这张卡把 read 结果里的全文摆到取走它的
 * 工具卡旁边 —— 与 AgentMessageCard 同族（`.event-block` 折叠行：单行缩略 + 点开全文），
 * 不是用户气泡：这条消息不是坐在键盘前的人说的。human 源不走这张卡（渲染为用户气泡，
 * 与 run-input 同口径，见 TranscriptWindow 的 inbox-read 分支）。
 *
 * 身份只有 read 结果给的那一层：`source`（agent / system），没有发送者名 ——
 * 服务端工具面不改（红线），卡头如实报「收件箱取走 · <source>」，不猜不造名字。
 */
import { cn } from '../../components/ui';
import { formatClock } from '../../format';
import { t } from '../../i18n';
import { StreamCard } from './StreamCard';

export function InboxReadCard({
  source,
  content,
  ts,
  defaultOpen = false,
  entering = false,
}: {
  /** 来源类别（read 结果的 `source`：agent / system / 其它运行时标签）。 */
  source: string;
  /** 消息全文（read 结果的 `text`）。 */
  content: string;
  /** 消费时刻（取走它的那次 read 的落位时间，Unix ms）；缺省不显示。 */
  ts?: number;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
  /** 本帧才追加进来的项：入场只播一次（判定见 `useEnteringItemKeys`）。 */
  entering?: boolean;
}) {
  const clock = formatClock(ts);
  return (
    <StreamCard
      className={cn('agent-message', entering && 'msg-enter')}
      ariaLabel={t('chat.inboxRead.group', { source })}
      defaultOpen={defaultOpen}
      title={
        <span className="max-w-56 truncate font-mono text-2xs tracking-wider text-accent">
          {t('chat.inboxRead.from', { source })}
        </span>
      }
      summary={content}
    >
      {clock !== '' && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs text-faint">
          <time className="shrink-0 tabular-nums" dateTime={new Date(ts ?? 0).toISOString()}>
            {clock}
          </time>
        </div>
      )}
      {/* 与 AgentMessageCard 同一口径：卡头已是「单行摘要 + 展开看全文」那一层，
          展开体直接是全文，不再套 MessageFold。 */}
      <p className="m-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
        {content}
      </p>
    </StreamCard>
  );
}
