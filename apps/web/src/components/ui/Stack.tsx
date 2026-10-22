import type { ElementType, HTMLAttributes, ReactNode } from 'react';

export type StackDirection = 'column' | 'row';
export type StackGap = 1 | 2 | 3 | 4 | 5 | 6;
export type StackElement = 'div' | 'section';

export interface StackProps extends Omit<HTMLAttributes<HTMLElement>, 'style'> {
  direction?: StackDirection;
  gap?: StackGap;
  as?: StackElement;
  children?: ReactNode;
}

export function Stack({
  direction = 'column',
  gap = 3,
  as = 'div',
  className,
  children,
  ...props
}: StackProps) {
  const Component = as as ElementType;
  const classes = [
    'ui-stack',
    direction === 'row' ? 'ui-stack-row' : '',
    `ui-stack-gap-${gap}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component {...props} className={classes}>
      {children}
    </Component>
  );
}
