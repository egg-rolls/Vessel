// biome-ignore-all lint/a11y/noSvgWithoutTitle: the ring is decorative (aria-hidden); the meter itself carries role="img" + aria-label with the full text
import { cn } from './cn';

/**
 * 上下文用量指示（发送按钮左侧）。
 *
 * 默认形态是**圆环**：弧长 = `used / max`，一眼看出「还剩多少」；精确数字不进
 * 可见正文，只作为 `aria-label`（读屏）——例如「59.0% / 590K」。**悬浮提示由宿主
 * 负责**：本包不依赖任何宿主组件，所以不写原生 `title`（否则会和宿主的应用内
 * tooltip 叠成两份），宿主拿同一条文案自己包 `Tooltip`。
 * 纯展示：不抢焦点、不可点击，也没有任何动画（因此 `prefers-reduced-motion`
 * 下自然静止）。
 *
 * 只做展示：数据由宿主从既有上下文来源注入（本仓库 Web 侧是 `agents.tree` 主 agent
 * 的 `context_used` / `context_max`）。**用量未知时由宿主不渲染**；这里再兜一次
 * 非法值，绝不填占位假数。`max` 未知时**不画圆环**（不假造比例），退成一个
 * 紧凑的已用值文本（如 `592K`）。
 */
export interface ComposerContextMeterProps {
  /** 已用 token 数。 */
  used: number;
  /** 上限；缺省表示未知（不画圆环，只显示 `text`）。 */
  max?: number;
  /** 读屏文案（调用方已翻译，如「59.0% / 590K」）；悬浮提示由宿主用同一条文案负责。 */
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
 * 已用 / 上限的真实比例（0 起、**未截断未取整**）；`max` 未知 / 非法时返回
 * `undefined` —— 不猜比例。取整口径（整数百分比 / 一位小数文案 / 圆环弧长）都从
 * 这一个比例派生，避免几处漂移。
 */
function contextFraction(used: number, max?: number): number | undefined {
  if (max === undefined || !Number.isFinite(max) || max <= 0) return undefined;
  if (!Number.isFinite(used) || used < 0) return undefined;
  return used / max;
}

/**
 * 用量比例（0–100 的整数百分比，超出上限截到 100）。
 *
 * `max` 未知 / 非法时返回 `undefined` —— 不猜比例。降级色阶（60 / 90）与圆环粗细
 * 读这个整数百分比；连续色阶读的是取整前的真实比例（见 {@link ringStroke}）。
 */
export function contextPercent(used: number, max?: number): number | undefined {
  const fraction = contextFraction(used, max);
  if (fraction === undefined) return undefined;
  return Math.min(100, Math.round(fraction * 100));
}

/**
 * 比例文案（tooltip / 读屏用）：**一位小数**，超过上限截到 `100.0`。
 *
 * `59.04 → '59.0'`、`59.96 → '60.0'`、`120 → '100.0'`。宿主拼 tooltip 时用它，
 * 与圆环共用同一个比例来源（{@link contextPercent} 只是取整口径不同）。
 */
export function contextPercentText(used: number, max?: number): string | undefined {
  const fraction = contextFraction(used, max);
  if (fraction === undefined) return undefined;
  return (Math.round(Math.min(1, fraction) * 1000) / 10).toFixed(1);
}

/**
 * 三个端点色：全部是既有 L1 token，不新增颜色、不写裸值。
 *
 * - `--muted`：默认色，与 `text-muted` 同一个 token（所以 0–60% 的观感和改版前一致）。
 * - `--amber`：真琥珀（本仓的 `--warn` 是中性灰，不黄）。
 * - `--danger`：危险色。
 *
 * `--amber` 带一个 `var()` 兜底：`packages/plugin-ui/src/styles.css`（本包独立发布
 * 用的 token 表）目前还没有 amber 一档，缺 token 时纯 `var(--amber)` 会让整条
 * `stroke` 变成无效值而失效；退到同样存在的 `--warn`（中性灰）至少是合法颜色，
 * 60–90 段退化成不变色，行为和旧版接近，圆环不会消失。
 */
const TONE_BASE = 'var(--muted)';
const TONE_AMBER = 'var(--amber, var(--warn))';
const TONE_DANGER = 'var(--danger)';

/**
 * 两色线性插值：`weight` 是 `from` 的占比（0–100），交给原生 `color-mix` 在 oklab
 * 里混（感知均匀，中间不会像 sRGB 那样发灰）。占比保留一位小数，DOM 里不出现
 * `12.3456789%` 这种噪声。
 */
function mixColor(from: string, weight: number, to: string): string {
  const share = Math.round(weight * 10) / 10;
  return `color-mix(in oklab, ${from} ${share}%, ${to})`;
}

/**
 * 圆环描边色：**四段连续**色阶。`pos` 是真实用量百分比（0–100，取整前）。
 *
 * | pos | 颜色 |
 * |---|---|
 * | 0–60 | 默认色（`--muted`），与改版前同色 |
 * | 60–80 | 默认色 → 琥珀：`t = (pos - 60) / 20`，琥珀占 `t × 100%`，其余默认色 |
 * | 80–90 | 琥珀 → 危险：`u = (pos - 80) / 10`，危险占 `u × 100%`，其余琥珀 |
 * | ≥90 | 危险色 |
 *
 * 接缝连续（左右极限相等，不跳色）：`pos = 60` 时琥珀 0% = 纯默认色；`pos = 80`
 * 时第一段给出纯琥珀、第二段危险 0% = 同一个琥珀；`pos = 90` 时第二段给出纯危险色。
 *
 * **降级**：`color-mix` / `in oklab` 不被支持时这条内联声明整条作废，`stroke` 继承
 * 外层 `<svg>` 的 `stroke-current`，颜色退回 {@link toneOf} 的**离散三档**
 * （<60 默认 / 60–89 琥珀 / ≥90 危险），形状与 ≥90 的加粗描边都不受影响。
 */
function ringStroke(pos: number): string {
  if (pos >= 90) return TONE_DANGER;
  if (pos > 80) return mixColor(TONE_DANGER, ((pos - 80) / 10) * 100, TONE_AMBER);
  if (pos > 60) return mixColor(TONE_AMBER, ((pos - 60) / 20) * 100, TONE_BASE);
  return TONE_BASE;
}

/**
 * 离散语义档（0–100 的**整数**百分比）：既是无混色能力时的降级色，也是圆环外层的
 * `currentColor`。四段渐进的红黄区段见 {@link ringStroke}；这里保留三档粗粒度。
 */
function toneOf(percent: number | undefined): string {
  if (percent === undefined) return 'text-faint';
  if (percent >= 90) return 'text-danger';
  if (percent >= 60) return 'text-amber';
  return 'text-muted';
}

/**
 * 比例圆环：底环 + 按比例截断的弧。弧色是 {@link ringStroke} 的连续色阶（内联
 * `stroke`）；`<svg>` 上的 `stroke-current` 只是降级载体 —— 内联值不可用时这里
 * 继承外层 {@link toneOf} 的语义色 token，仍能读出三档。底环用 `line-strong`；
 * ≥90% 时描边再加粗一档，色觉差异之外还有形状差异。
 */
function ContextRing({ ratio, percent }: { ratio: number; percent: number }) {
  const strokeWidth = percent >= 90 ? 3 : 2.5;
  // 只保留两位小数：DOM 里不出现 30.159289474462004 这种噪声。
  const dash = Math.round(RING_CIRCUMFERENCE * ratio * 100) / 100;
  // 色阶读**取整前**的比例：60% 附近不会因为取整先跳一格再变色。
  const stroke = ringStroke(ratio * 100);
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="block shrink-0 stroke-current"
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
          style={{ stroke }}
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
  const fraction = contextFraction(used, max);
  const percent = contextPercent(used, max);
  // 弧长用取整前的真实比例：59.6% 不会提前画成满格，59% 也不会少画一段。
  const ratio = fraction === undefined ? undefined : Math.min(1, fraction);

  return (
    <span
      role="img"
      aria-label={title}
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
