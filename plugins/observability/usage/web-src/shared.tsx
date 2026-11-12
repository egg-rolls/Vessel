import {
  Button,
  type PluginRpcClient,
  Section,
  SegmentedTabs,
  type TabOption,
} from '@vessel-agent/plugin-ui';
import type { ReactNode } from 'react';
import type { SourceCoverage } from '../src/aggregate.js';
import type { Translator } from './i18n';

export interface ViewProps {
  client: PluginRpcClient;
  /** Bumped by `vessel.plugin.refresh`; views refetch when it changes. */
  refreshKey: number;
  t: Translator;
}

/**
 * "How much of the trace is behind these numbers" — shared by Usage and Logs.
 *
 * Both pages are built from the same reader, so both can be looking at a partial
 * view; the two pages differ only in what they render, never in how coverage is
 * judged. Hence one component (and one pair of copy keys, `logs.truncated.*`:
 * usage records come from run files too, so "run files in this range" reads
 * correctly on both) instead of a copy per view.
 *
 * Two notices, because the reader reports two kinds of incompleteness and only
 * one of them hides *runs*: `files_truncated` means some run files inside the
 * range were never read (read-budget / file-count cap), `partial_files` means
 * counted files whose oldest lines were dropped. A count that silently covers 43
 * of 176 runs of the selected range must never look like the total.
 */
export function CoverageNotice({
  source,
  t,
}: {
  source: SourceCoverage | null | undefined;
  t: Translator;
}) {
  if (source === null || source === undefined) return null;
  // A payload from before the split only carried `truncated`; read it as "some
  // run files were not counted".
  const legacy = source.files_truncated === undefined && source.partial_files === undefined;
  const filesTruncated = source.files_truncated ?? (legacy ? source.truncated : false);
  const partial = source.partial_files ?? 0;
  if (!filesTruncated && partial === 0) return null;
  const total = source.files_in_window ?? source.files_total;
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
      {filesTruncated ? (
        <p>{t('logs.truncated.files', { files: source.files_read, total })}</p>
      ) : null}
      {partial > 0 ? <p>{t('logs.truncated.partial', { files: partial })}</p> : null}
    </div>
  );
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
