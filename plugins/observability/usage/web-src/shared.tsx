import {
  Button,
  type PluginRpcClient,
  Section,
  SegmentedTabs,
  type TabOption,
} from '@vessel-agent/plugin-ui';
import type { ReactNode } from 'react';

export interface ViewProps {
  client: PluginRpcClient;
  /** Bumped by `vessel.plugin.refresh`; views refetch when it changes. */
  refreshKey: number;
}

export type RangeValue = '7' | '30' | '90' | '0';

const RANGES: readonly TabOption<RangeValue>[] = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '0', label: 'All time' },
];

/** `days` is omitted for "all time" so the backend uses its default range. */
export function rangeParams(range: RangeValue): { days?: number } {
  const days = Number(range);
  return days > 0 ? { days } : {};
}

export function RangeTabs({
  value,
  onChange,
}: {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
}) {
  return (
    <SegmentedTabs
      label="Time range"
      tabs={RANGES}
      value={value}
      onChange={onChange}
      className="mt-0"
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        <p className="mt-1 max-w-prose text-md text-muted">{description}</p>
      </div>
      {actions !== undefined ? (
        <div className="flex flex-wrap items-end gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="py-6 text-md text-muted" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <Section title={title} description={description} />;
}

export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this view',
}: {
  error: Error;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <Section
      title={title}
      description={error.message}
      actions={
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}
