import { Fragment, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export interface KeyValueItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
}

export interface KeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  items: KeyValueItem[];
}

/** 两列 dl 网格：等价 legacy `.diag-list`，value 可断行。 */
export function KeyValueList({ items, className, ...props }: KeyValueListProps) {
  return (
    <dl
      {...props}
      className={cn(
        'mt-2.5 grid grid-cols-[minmax(90px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-md',
        className,
      )}
    >
      {items.map((item, index) => (
        <Fragment key={item.key ?? index}>
          <dt className="text-faint">{item.label}</dt>
          <dd className="min-w-0 wrap-anywhere text-ink">{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
