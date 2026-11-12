/**
 * 「rotate 交接」卡：新身体的第一条启动嘱托在时间线上的唯一表示。
 *
 * 为什么不是用户气泡：这句话不是坐在键盘前的人打的，而是发起 rotate 的那具身体（通常是
 * 上一具）写的交接书；渲成气泡会让人以为是自己刚发的（真实案例：main epoch 2 → 3 的
 * 自我交接，交接书和用户气泡一模一样）。为什么也不是环境信息：它是**该轮真实的用户
 * 输入**，是新身体这一轮唯一的工作指令，必须能读、而且要与「工具 / 系统提示」区分开。
 *
 * 视觉与「来自 agent X」卡 / 环境信息卡同族（同一张 `StreamCard`，同一套展开机制）：
 * - 卡头 title 槽 = `⟳ rotate 交接`；
 * - 卡头 meta 槽 = `epoch N`（来自消息名第三段；没有就不写，不猜）；
 * - **默认展开**：正文是新身体唯一的指令，做成默认折起等于让人抄不到活。折叠（用户
 *   自己点）时卡头仍留一行摘要，正文不被截断 —— 展开体是完整原文，不做任何截断。
 * - 展开体首行是一句来源说明（等宽 / 淡色，与 agent 卡的来源地址同位置）：它写的不是
 *   人打的字。发起者身份（谁写的）今天拿不到，所以只写能确定的事实。
 */
import { cn } from '../../components/ui';
import { formatClock } from '../../format';
import { t } from '../../i18n';
import type { RotateHandoff } from './rotate-handoff';
import { StreamCard } from './StreamCard';

export function RotateHandoffCard({
  handoff,
  content,
  ts,
  defaultOpen = true,
  entering = false,
}: {
  /** `rotate-handoff.ts` 解析出的元数据（epoch 可能缺失）。 */
  handoff: RotateHandoff;
  /** 正文（与 `Message.content` / `run.started.input` 同源，一字不改）。 */
  content: string;
  /** 这条消息的时间（Unix ms）；缺省不显示，与 agent 卡同一处理。 */
  ts?: number;
  /**
   * 默认展开。**调用方恒传 true**（正文是新身体唯一的指令）：这个参数存在只是为了
   * 与其它卡同一形状，`ui.expandCards` 不再参与判定。
   */
  defaultOpen?: boolean;
  /** 本帧才追加进来的项：入场只播一次（判定见 `useEnteringItemKeys`）。 */
  entering?: boolean;
}) {
  const clock = formatClock(ts);
  return (
    <StreamCard
      className={cn('rotate-handoff-card w-full min-w-0 max-w-full', entering && 'msg-enter')}
      ariaLabel={
        handoff.epoch !== undefined
          ? t('chat.rotateHandoff.aria', { epoch: handoff.epoch })
          : t('chat.rotateHandoff.title')
      }
      defaultOpen={defaultOpen}
      title={
        <span className="max-w-56 truncate font-mono text-2xs tracking-wider text-accent">
          {t('chat.rotateHandoff.title')}
        </span>
      }
      meta={
        handoff.epoch !== undefined
          ? t('chat.rotateHandoff.epoch', { epoch: handoff.epoch })
          : undefined
      }
      summary={content}
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs text-faint">
        <span className="min-w-0 break-words">{t('chat.rotateHandoff.source')}</span>
        {clock !== '' && (
          <time className="shrink-0 tabular-nums" dateTime={new Date(ts ?? 0).toISOString()}>
            {clock}
          </time>
        )}
      </div>
      <p className="m-0 whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink">
        {content}
      </p>
    </StreamCard>
  );
}
