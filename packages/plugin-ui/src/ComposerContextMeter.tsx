import { cn } from './cn';

/**
 * 上下文用量小条（发送按钮左侧）。
 *
 * 只做展示：数据由宿主从既有上下文来源注入（本仓库 Web 侧是会话头那份
 * `context_used` / `context_max`）。**用量未知时由宿主不渲染**；这里再兜一次
 * 非法值，绝不填占位假数。`max` 未知时只显示已用 token 数，不猜百分比。
 */
export interface ComposerContextMeterProps {
  /** 已用 token 数。 */
  used: number;
  /** 上限；缺省表示未知（不显示百分比与进度条）。 */
  max?: number;
  /** 读屏 / 悬浮明细（调用方已翻译，如「42K / 100K」）。 */
  title: string;
  /** 可见紧凑文字；缺省按 used / max 计算。 */
  text?: string;
  className?: string;
}

/** 70% 起提醒、90% 起危险：与其它用量提示同一口径。 */
function toneOf(percent: number | undefined): string {
  if (percent === undefined) return 'text-faint';
  if (percent >= 90) return 'text-danger';
  if (percent >= 70) return 'text-warn';
  return 'text-muted';
}

function barOf(percent: number | undefined): string {
  if (percent === undefined) return 'bg-line-strong';
  if (percent >= 90) return 'bg-danger';
  if (percent >= 70) return 'bg-warn';
  return 'bg-accent';
}

export function ComposerContextMeter({
  used,
  max,
  title,
  text,
  className,
}: ComposerContextMeterProps) {
  if (!Number.isFinite(used) || used < 0) return null;
  const percent =
    max !== undefined && Number.isFinite(max) && max > 0
      ? Math.min(100, Math.round((used / max) * 100))
      : undefined;
  const shown = text ?? (percent !== undefined ? `${percent}%` : String(Math.round(used)));

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-flex items-center gap-1.5', toneOf(percent), className)}
    >
      {percent !== undefined && (
        <span
          aria-hidden="true"
          className="block h-1 w-8 overflow-hidden rounded-full bg-line-strong"
        >
          <span
            className={cn('block h-full rounded-full', barOf(percent))}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      <span className="font-mono text-xs whitespace-nowrap tabular-nums">{shown}</span>
    </span>
  );
}
