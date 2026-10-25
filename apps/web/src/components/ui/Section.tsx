import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleAs?: 'h2' | 'h3';
  as?: 'section' | 'div';
  children?: ReactNode;
}

/** 结构面板：等价 legacy `.panel` + `.panel-header` / `.section-title`。 */
export function Section({
  title,
  description,
  actions,
  titleAs = 'h2',
  as = 'section',
  className,
  children,
  ...props
}: SectionProps) {
  const Root = as;
  const Title = titleAs;
  const hasHeader = title != null || description != null || actions != null;

  return (
    <Root
      {...props}
      className={cn(
        'rounded-md bg-raised px-4.5 py-4 shadow-elev-1 max-compact:px-4 forced-colors:border',
        className,
      )}
    >
      {hasHeader ? (
        <div className="flex flex-wrap items-center gap-2.5">
          {title != null || description != null ? (
            <div className="min-w-0">
              {title != null ? (
                <Title className="text-md font-semibold text-ink">{title}</Title>
              ) : null}
              {description != null ? (
                <p className="mt-1.5 max-w-prose text-md text-muted">{description}</p>
              ) : null}
            </div>
          ) : null}
          {actions}
        </div>
      ) : null}
      {children != null ? <div className={hasHeader ? 'mt-2.5' : undefined}>{children}</div> : null}
    </Root>
  );
}
