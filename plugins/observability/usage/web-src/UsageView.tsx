import { DataTable, type DataTableColumn, Section, Stat } from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useState } from 'react';
import type { DayBucket, SummaryResult } from '../src/aggregate.js';
import { costHint, fmtCost, fmtInt, fmtPct, ratioHint } from './format';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  type LoadState,
  PageHeader,
  RangeTabs,
  type RangeValue,
  rangeParams,
  toError,
  type ViewProps,
} from './shared';

const DAY_COLUMNS: readonly DataTableColumn<DayBucket>[] = [
  { key: 'date', header: 'Day', cell: (row) => row.date },
  { key: 'requests', header: 'Requests', cell: (row) => fmtInt(row.requests) },
  { key: 'prompt', header: 'Prompt', cell: (row) => fmtInt(row.prompt_tokens) },
  { key: 'completion', header: 'Completion', cell: (row) => fmtInt(row.completion_tokens) },
  { key: 'cache_read', header: 'Cache read', cell: (row) => fmtInt(row.cache_read_tokens) },
  { key: 'failed', header: 'Failed', cell: (row) => fmtInt(row.failed_runs) },
  { key: 'unpriced', header: 'Unpriced', cell: (row) => fmtInt(row.unpriced_requests) },
  { key: 'cost', header: 'Cost', cell: (row) => fmtCost(row.cost) },
];

interface StatEntry {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

function summaryStats(data: SummaryResult): StatEntry[] {
  const totals = data.totals;
  return [
    {
      key: 'requests',
      label: 'Requests',
      value: fmtInt(totals.requests),
      hint: totals.failed_runs > 0 ? `${fmtInt(totals.failed_runs)} failed run(s)` : undefined,
    },
    {
      key: 'prompt',
      label: 'Prompt tokens',
      value: fmtInt(totals.prompt_tokens),
      hint: 'Includes cache counters',
    },
    {
      key: 'completion',
      label: 'Completion tokens',
      value: fmtInt(totals.completion_tokens),
    },
    {
      key: 'cache_read',
      label: 'Cache read',
      value: fmtInt(totals.cache_read_tokens),
      hint:
        totals.cache_read_tokens === undefined
          ? 'Not reported by provider'
          : 'Read from the prompt cache',
    },
    {
      key: 'input_share',
      label: 'Input share',
      value: fmtPct(data.input_share),
      hint: ratioHint(data.input_share_unavailable, 'Cache read / prompt tokens'),
    },
    {
      key: 'prefix_health',
      label: 'Prefix health',
      value: fmtPct(data.prefix_health),
      hint: ratioHint(data.prefix_health_unavailable, 'Cache read / (read + write)'),
    },
    {
      key: 'cost',
      label: 'Cost',
      value: fmtCost(data.cost),
      hint: costHint(data),
    },
  ];
}

function UsageBody({ data }: { data: SummaryResult }) {
  if (!data.has_data) {
    return (
      <EmptyState
        title="No usage data yet"
        description="Run a request through Vessel. Usage appears here once the event log has records in the selected range."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 compact:grid-cols-3 wide:grid-cols-4">
        {summaryStats(data).map((entry) => (
          <Stat key={entry.key} label={entry.label} value={entry.value} hint={entry.hint} />
        ))}
      </div>
      <Section title="By day">
        <DataTable columns={DAY_COLUMNS} rows={data.by_day} rowKey={(row) => row.date} />
      </Section>
    </>
  );
}

export function UsageView({ client, refreshKey }: ViewProps) {
  const [range, setRange] = useState<RangeValue>('30');
  const [state, setState] = useState<LoadState<SummaryResult>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / attempt are explicit refetch triggers.
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void client
      .call<SummaryResult>('summary', rangeParams(range))
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch((reason: unknown) => {
        if (active) setState({ status: 'error', error: toError(reason) });
      });
    return () => {
      active = false;
    };
  }, [client, range, refreshKey, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Usage"
        description="Requests, tokens, cache and cost from persisted run history."
        actions={<RangeTabs value={range} onChange={setRange} />}
      />
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' ? <UsageBody data={state.data} /> : null}
    </div>
  );
}
