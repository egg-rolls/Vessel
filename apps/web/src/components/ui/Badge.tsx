import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'warn' | 'danger' | 'ok';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'style'> {
  tone?: BadgeTone;
  children?: ReactNode;
}

export function Badge({ tone = 'neutral', className, children, ...props }: BadgeProps) {
  const classes = ['ui-badge', `ui-badge-${tone}`, className].filter(Boolean).join(' ');

  return (
    <span {...props} className={classes}>
      {children}
    </span>
  );
}
