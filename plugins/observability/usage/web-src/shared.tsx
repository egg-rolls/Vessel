import {
  Button,
  type PluginRpcClient,
  Section,
  SegmentedTabs,
  type TabOption,
} from '@vessel-agent/plugin-ui';
import type { ReactNode } from 'react';
import type { Translator } from './i18n';

export interface ViewProps {
  client: PluginRpcClient;
  /** Bumped by `vessel.plugin.refresh`; views refetch when it changes. */
  refreshKey: number;
  t: Translator;
}

export type RangeValue = '7' | '30' | '90' | '0';

function rangeTabs(t: Translator): readonly TabOption<RangeValue>[] {
  return [
    { id: '7', label: t('range.7') },
    { id: '30', label: t('range.30') },
    { id: '90', label: t('range.90') },
    { id: '0', label: t('range.0') },
  ];
}

/** `days` is omitted for "all time" so the backend uses its default range. */
export function rangeParams(range: RangeValue): { days?: number } {
  const days = Number(range);
  return days > 0 ? { days } : {};
}

export function RangeTabs({
  value,
  onChange,
  t,
}: {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
  t: Translator;
}) {
  return (
    <SegmentedTabs
      label={t('range.label')}
      tabs={rangeTabs(t)}
      value={value}
      onChange={onChange}
      className="mt-0"
    />
  );
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p className="py-6 text-md text-muted" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <Section title={title} description={description} />;
}

/** Minimal rounded frame for tables: no card background, heading or padding. */
export function TableFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-md">{children}</div>;
}

export function ErrorState({
  error,
  onRetry,
  title,
  retryLabel,
}: {
  error: Error;
  onRetry: () => void;
  title: string;
  retryLabel: string;
}) {
  return (
    <Section
      title={title}
      description={error.message}
      actions={
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      }
    />
  );
}
