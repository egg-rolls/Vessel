import { cva } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** tone 名：**运行时数组 = 唯一事实源**（类型由它派生，预览直接遍历）。 */
export const COUNT_BADGE_TONES = ['muted', 'accent'] as const;

export type CountBadgeTone = (typeof COUNT_BADGE_TONES)[number];

/** tone → class；`satisfies Record<CountBadgeTone, string>` 双向钉住数组与 cva 键集合。 */
const COUNT_BADGE_TONE_CLASS = {
  muted: 'bg-sunken text-muted',
  accent: 'bg-accent-soft text-accent-ink',
} satisfies Record<CountBadgeTone, string>;

/**
 * 数字徽标：只承接「有多少条」这类元信息。
 *
 * 与 `Badge`（行内文字标签）分工：计数不该抢主题色，默认走 muted 系；
 * `accent` 只给“当前项里也有计数”的场景做轻微强调。
 */
const countBadge = cva(
  'inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full px-1.5 font-mono text-2xs tabular-nums leading-none',
  {
    variants: { tone: COUNT_BADGE_TONE_CLASS },
    defaultVariants: { tone: 'muted' },
  },
);

export interface CountBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  count: number;
  /** 超过该值显示 `max+`；默认 99。 */
  max?: number;
  tone?: CountBadgeTone;
  /**
   * 无障碍文案（调用方传入，组件不依赖 i18n）。
   * 提供时数字对 AT 隐藏，只读这句话；缺省时数字本身可读。
   */
  label?: string;
}

/**
 * `count <= 0` 渲染 `null`：调用方不必为“0 条”额外写条件判断，
 * 也不会在界面里出现一个孤立的 0。
 */
export function CountBadge({ count, max = 99, tone, label, className, ...props }: CountBadgeProps) {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (value <= 0) return null;
  const text = value > max ? `${max}+` : String(value);

  return (
    <span {...props} className={cn(countBadge({ tone }), className)}>
      <span aria-hidden={label !== undefined ? true : undefined}>{text}</span>
      {label !== undefined ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
