import { cva } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * tone 名：**运行时数组 = 唯一事实源**（类型由它派生）。
 * 设计实验室直接遍历它出图，新增 tone 不用改预览。
 */
export const BADGE_TONES = ['neutral', 'accent', 'info', 'warn', 'danger', 'success'] as const;

export type BadgeTone = (typeof BADGE_TONES)[number];

/**
 * tone → class。`satisfies Record<BadgeTone, string>` 双向钉住数组与 cva 键集合：
 * 数组有而这里漏写（缺属性）或这里写了而数组没有（多余属性）都会编译报错。
 */
const BADGE_TONE_CLASS = {
  neutral: '',
  accent: 'bg-accent-soft text-accent-ink',
  info: 'bg-info-soft text-info',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  success: 'bg-success-soft text-success',
} satisfies Record<BadgeTone, string>;

const badge = cva(
  'inline-flex max-w-full items-center whitespace-nowrap rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-faint',
  {
    variants: { tone: BADGE_TONE_CLASS },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** 行内标签：权限、来源、计数等短元数据。 */
export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span {...props} className={cn(badge({ tone }), className)} />;
}
