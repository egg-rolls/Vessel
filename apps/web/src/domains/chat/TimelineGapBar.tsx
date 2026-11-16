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
  // 措辞按**成因**分流：只有 `source === 'holes'` 才许提"洞"（写入侧声明的永久不可读）。
  // 其余四种是四条校验的具体失败，各说清"发生了什么" —— 混成一句"有缺口（已声明为洞）"
  // 会在真丢事件时骗人（真机那次 `holes.ndjson` 是 0 行）。
  const bodyKey =
    last === undefined
      ? 'timeline.gap.body'
      : last.source === 'holes'
        ? 'timeline.gap.body.holes'
        : last.rule === 1
          ? 'timeline.gap.body.rule1'
          : last.rule === 2
            ? 'timeline.gap.body.rule2'
            : last.rule === 3
              ? 'timeline.gap.body.rule3'
              : last.rule === 4
                ? 'timeline.gap.body.rule4'
                : 'timeline.gap.body';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="timeline-gap-bar"
      data-gap-source={last?.source ?? ''}
      data-gap-rule={last?.rule ?? ''}
      className="mx-4 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    >
      <span className="font-medium">{t('timeline.gap.title')}</span>{' '}
      <span>{t(bodyKey, { range })}</span>
      {last === undefined ? null : (
        <span className="ml-1 opacity-70">
          {t('timeline.gap.detail', { expected: last.expected, received: last.received })}
        </span>
      )}
    </div>
  );
}
