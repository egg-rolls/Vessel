import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

const badge = cva(
  'inline-flex max-w-full items-center whitespace-nowrap rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-faint',
  {
    variants: {
      tone: {
        neutral: '',
        accent: 'bg-accent-soft text-accent-ink',
        info: 'bg-info-soft text-info',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
        success: 'bg-success-soft text-success',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** 行内标签：权限、来源、计数等短元数据。 */
export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span {...props} className={cn(badge({ tone }), className)} />;
}
