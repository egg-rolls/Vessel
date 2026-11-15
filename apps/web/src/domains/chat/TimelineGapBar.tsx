import type { TimelineGapState } from '../../gateway/timeline-protocol';
import { t } from '../../i18n';

/**
 * 时间线的**污点条**（ADR-105 §6：「污点标记但不阻断渲染」）。
 *
 * 为什么必须有它：0.54 之前缺口是被静默吸收的（`push` 丢掉 `seq <= lastSeq`、`gap` 帧
 * 「静默处理、页面感知不到截断」）。单游标 + 四条校验之后，缺口只有两种成因 ——
 * 写者**声明**的洞（磁盘/坏块，永久保留）或客户端算错（重拉一次仍不过）—— 两种都必须
 * **看得见**：条上写清区间与期望/实收，下面的时间线照常渲染。
 *
 * 不做的事：不阻断渲染、不清空时间线、不自动重试（重拉在订阅层做过一次）。
 */
export function TimelineGapBar({ gap }: { gap: TimelineGapState }): React.ReactElement | null {
  if (!gap.tainted) return null;
  const last = gap.last;
  const range = last === undefined ? '' : `seq ${String(last.from_seq)}–${String(last.to_seq)}`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="timeline-gap-bar"
      className="mx-4 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    >
      <span className="font-medium">{t('timeline.gap.title')}</span>{' '}
      <span>{t('timeline.gap.body', { range })}</span>
      {last === undefined ? null : (
        <span className="ml-1 opacity-70">
          {t('timeline.gap.detail', { expected: last.expected, received: last.received })}
        </span>
      )}
    </div>
  );
}
