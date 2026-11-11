// biome-ignore-all lint/a11y/noSvgWithoutTitle: the ring is decorative (aria-hidden); the meter itself carries role="img" + aria-label with the full text
import { cn } from './cn';

/**
 * 上下文用量指示（发送按钮左侧）。
 *
 * 默认形态是**圆环**：弧长 = `used / max`，一眼看出「还剩多少」；精确数字不进
 * 可见正文，放在原生 `title`（hover）里，同时作为 `aria-label`（读屏）——
 * 例如「59% / 592K of 1M」。纯展示：不抢焦点、不可点击，也没有任何动画
 * （因此 `prefers-reduced-motion` 下自然静止）。
 *
 * 只做展示：数据由宿主从既有上下文来源注入（本仓库 Web 侧是会话头那份
 * `context_used` / `context_max`）。**用量未知时由宿主不渲染**；这里再兜一次
 * 非法值，绝不填占位假数。`max` 未知时**不画圆环**（不假造比例），退成一个
 * 紧凑的已用值文本（如 `592K`）。
 */
export interface ComposerContextMeterProps {
  /** 已用 token 数。 */
  used: number;
  /** 上限；缺省表示未知（不画圆环，只显示 `text`）。 */
  max?: number;
  /** 读屏 / 悬浮明细（调用方已翻译，如「59% / 592K of 1M」）。 */
  title: string;
  /**
   * 已用 token 的**紧凑**文本（如 `592K` / `1.2K` / `3.4M`）。
   * 只在 `max` 未知时可见 —— 有比例时圆环就是正文，数字只进 `title`。
   */
  text?: string;
  className?: string;
}

/** 圆环几何：viewBox 20×20、半径 8、描边 2.5（按 18px 渲染 ≈ 2.3px 粗，直径 ≈ 16.6px）。 */
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = Math.round(2 * Math.PI * RING_RADIUS * 100) / 100;

/** 渲染边长（px）：18px 与工具栏 `text-xs` 按钮行高协调，不撑高工具栏。 */
const RING_SIZE = 18;

/**
 * 用量比例（0–100 的整数百分比，超出上限截到 100）。
 *
 * `max` 未知 / 非法时返回 `undefined` —— 不猜比例。宿主构造 tooltip 文案时复用
 * 同一个函数，避免两处取整口径漂移。
 */
export function contextPercent(used: number, max?: number): number | undefined {
  if (max === undefined || !Number.isFinite(max) || max <= 0) return undefined;
  if (!Number.isFinite(used) || used < 0) return undefined;
  return Math.min(100, Math.round((used / max) * 100));
}

/** 70% 起提醒、90% 起危险：与其它用量提示同一口径。 */
function toneOf(percent: number | undefined): string {
  if (percent === undefined) return 'text-faint';
  if (percent >= 90) return 'text-danger';
  if (percent >= 70) return 'text-warn';
  return 'text-muted';
}

/**
 * 比例圆环：底环 + 按比例截断的弧。颜色靠 `currentColor`（外层 {@link toneOf}
 * 的语义色 token），底环用 `line-strong`；≥90% 时描边再加粗一档，色觉差异之外
 * 还有形状差异。
 */
function ContextRing({ ratio, percent }: { ratio: number; percent: number }) {
  const strokeWidth = percent >= 90 ? 3 : 2.5;
  // 只保留两位小数：DOM 里不出现 30.159289474462004 这种噪声。
  const dash = Math.round(RING_CIRCUMFERENCE * ratio * 100) / 100;
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="block shrink-0"
    >
      <circle
        cx={10}
        cy={10}
        r={RING_RADIUS}
        strokeWidth={strokeWidth}
        className="stroke-line-strong"
      />
      {ratio > 0 && (
        <circle
          cx={10}
          cy={10}
          r={RING_RADIUS}
          strokeWidth={strokeWidth}
          strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 10 10)"
          className="stroke-current"
        />
      )}
    </svg>
  );
}

export function ComposerContextMeter({
  used,
  max,
  title,
  text,
  className,
}: ComposerContextMeterProps) {
  if (!Number.isFinite(used) || used < 0) return null;
  const percent = contextPercent(used, max);
  // 弧长用取整前的真实比例：59.6% 不会提前画成满格，59% 也不会少画一段。
  const ratio = percent === undefined || max === undefined ? undefined : Math.min(1, used / max);

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-flex items-center gap-1.5', toneOf(percent), className)}
    >
      {ratio !== undefined && percent !== undefined ? (
        <ContextRing ratio={ratio} percent={percent} />
      ) : (
        <span className="font-mono text-xs whitespace-nowrap tabular-nums">
          {text ?? String(Math.round(used))}
        </span>
      )}
    </span>
  );
}
