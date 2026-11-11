/**
 * 「待批答复」卡：async `ask_user` 的答案在时间线上的唯一表示。
 *
 * 为什么不是用户气泡：这句话的人**不是在输入框里打的**，而是在待批页回答的；
 * 渲染成气泡会让人以为是自己刚发的消息（点发送的人确实不是他）。为什么也不是环境信息：
 * 它是一次真实的人类决策，属于该轮的用户输入，必须与「工具/系统提示」区分开。
 * 所以：同一张 `StreamCard`（时间线唯一卡片结构），卡头写「待批答复 · <问题摘要>」，
 * 展开体是逐题答案 + 来源 + 时间。
 *
 * 数据仍是那条 user 消息（协议要求、历史一致）：本卡只换表示层，不复制、不改写正文。
 */
import { formatClock } from '../../format';
import { t } from '../../i18n';
import type { AskAnswerCard as AskAnswerData } from './ask-answer';
import { StreamCard } from './StreamCard';

export function AskAnswerCard({
  card,
  ts,
  defaultOpen = false,
}: {
  /** `ask-answer.ts` 解析后的卡片数据。 */
  card: AskAnswerData;
  /** 这条答案消息的时间（Unix ms）；缺省不显示，与 agent 卡同一处理。 */
  ts?: number;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
}) {
  const clock = formatClock(ts);
  return (
    <StreamCard
      className="ask-answer-card w-full min-w-0 max-w-full"
      ariaLabel={t('chat.askAnswer.aria')}
      defaultOpen={defaultOpen}
      title={
        <>
          <span className="font-mono text-2xs tracking-wider text-accent">
            {t('chat.askAnswer.title')}
          </span>
          <span className="max-w-56 truncate text-sm text-ink">{card.summary}</span>
        </>
      }
      meta={card.requestId !== undefined ? `#${card.requestId.slice(0, 8)}` : undefined}
      summary={card.rows[0]?.text}
    >
      {(clock !== '' || card.requestId !== undefined) && (
        // 与 agent 卡 / 环境卡同一个位置：展开体首行，等宽 / 淡色 / 可选中。
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs text-faint">
          <span className="shrink-0">{t('chat.askAnswer.source')}</span>
          {card.requestId !== undefined && (
            <span className="break-all select-all">{card.requestId}</span>
          )}
          {clock !== '' && (
            <time className="shrink-0 tabular-nums" dateTime={new Date(ts ?? 0).toISOString()}>
              {clock}
            </time>
          )}
        </div>
      )}
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
        {card.rows.map((row) => (
          <li
            className="min-w-0 break-words text-sm leading-relaxed text-ink"
            key={`${row.label}\u0000${row.text}`}
          >
            <span className="mr-1.5 font-mono text-2xs tracking-wider text-accent-ink">
              {row.label}
            </span>
            <span className="whitespace-pre-wrap wrap-anywhere">{row.text}</span>
          </li>
        ))}
      </ul>
    </StreamCard>
  );
}
