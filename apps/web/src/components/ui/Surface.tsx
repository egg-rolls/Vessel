import type { ElementType, HTMLAttributes, ReactNode } from 'react';

export type SurfaceElement = 'div' | 'section' | 'footer' | 'fieldset';

export interface SurfaceProps extends Omit<HTMLAttributes<HTMLElement>, 'style'> {
  as?: SurfaceElement;
  children?: ReactNode;
}

export function Surface({ as = 'div', className, children, ...props }: SurfaceProps) {
  const Component = as as ElementType;
  const classes = ['ui-surface', className].filter(Boolean).join(' ');

  return (
    <Component {...props} className={classes}>
      {children}
    </Component>
  );
}
