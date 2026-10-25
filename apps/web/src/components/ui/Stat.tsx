import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface StatProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}

/** 指标块。 */
export function Stat({ label, value, hint, className, ...props }: StatProps) {
  return (
    <div
      {...props}
      className={cn(
        'flex flex-col gap-0.5 rounded-md bg-raised px-3.5 py-3 shadow-elev-1 forced-colors:border',
        className,
      )}
    >
      <span className="font-mono text-xl tabular-nums text-ink wrap-anywhere">{value}</span>
      <span className="text-xs tracking-wider text-faint">{label}</span>
      {hint != null ? <span className="text-xs text-faint">{hint}</span> : null}
    </div>
  );
}
