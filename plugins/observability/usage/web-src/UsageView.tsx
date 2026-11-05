import {
  DataTable,
  type DataTableColumn,
  PluginPage,
  PluginPageHeader,
  Stat,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useState } from 'react';
import type { DayBucket, LeaderboardResult, SummaryResult } from '../src/aggregate.js';
import { costHint, fmtCost, fmtInt, fmtPct, ratioHint } from './format';
import type { Translator } from './i18n';
import { ModelTable } from './ModelTable';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  type LoadState,
  RangeTabs,
  type RangeValue,
  rangeParams,
  TableFrame,
  toError,
  type ViewProps,
} from './shared';

function dayColumns(t: Translator): readonly DataTableColumn<DayBucket>[] {
  return [
    { key: 'date', header: t('usage.th.day'), cell: (row) => row.date },
    { key: 'requests', header: t('usage.th.requests'), cell: (row) => fmtInt(row.requests) },
    { key: 'prompt', header: t('usage.th.prompt'), cell: (row) => fmtInt(row.prompt_tokens) },
    {
      key: 'completion',
      header: t('usage.th.completion'),
      cell: (row) => fmtInt(row.completion_tokens),
    },
    {
      key: 'cache_read',
      header: t('usage.th.cacheRead'),
      cell: (row) => fmtInt(row.cache_read_tokens),
    },
    { key: 'failed', header: t('usage.th.failed'), cell: (row) => fmtInt(row.failed_runs) },
    {
      key: 'unpriced',
      header: t('usage.th.unpriced'),
      cell: (row) => fmtInt(row.unpriced_requests),
    },
    { key: 'cost', header: t('usage.th.cost'), cell: (row) => fmtCost(row.cost) },
  ];
}

interface StatEntry {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

function summaryStats(data: SummaryResult, t: Translator): StatEntry[] {
  const totals = data.totals;
  return [
    {
      key: 'requests',
      label: t('usage.requests'),
      value: fmtInt(totals.requests),
      hint:
        totals.failed_runs > 0
          ? t('usage.failedRuns', { n: fmtInt(totals.failed_runs) })
          : undefined,
    },
    {
      key: 'prompt',
      label: t('usage.promptTokens'),
      value: fmtInt(totals.prompt_tokens),
      hint: t('usage.promptHint'),
    },
    {
      key: 'completion',
      label: t('usage.completionTokens'),
      value: fmtInt(totals.completion_tokens),
    },
    {
      key: 'cache_read',
      label: t('usage.cacheRead'),
      value: fmtInt(totals.cache_read_tokens),
      hint:
        totals.cache_read_tokens === undefined ? t('usage.cacheNotReported') : t('usage.cacheHint'),
    },
    {
      key: 'input_share',
      label: t('usage.inputShare'),
      value: fmtPct(data.input_share),
      hint: ratioHint(data.input_share_unavailable, t('usage.inputShareHint'), t),
    },
    {
      key: 'prefix_health',
      label: t('usage.prefixHealth'),
      value: fmtPct(data.prefix_health),
      hint: ratioHint(data.prefix_health_unavailable, t('usage.prefixHealthHint'), t),
    },
    {
      key: 'cost',
      label: t('usage.cost'),
      value: fmtCost(data.cost),
      hint: costHint(data, t),
    },
  ];
}

function TableHeading({ children }: { children: string }) {
  return <h2 className="font-mono text-2xs uppercase tracking-widest text-faint">{children}</h2>;
}

interface UsageData {
  summary: SummaryResult;
  models: LeaderboardResult;
}

function UsageBody({ data, t }: { data: UsageData; t: Translator }) {
  const { summary, models } = data;
  if (!summary.has_data) {
    return <EmptyState title={t('usage.empty.title')} description={t('usage.empty.description')} />;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 compact:grid-cols-3 wide:grid-cols-4">
        {summaryStats(summary, t).map((entry) => (
          <Stat key={entry.key} label={entry.label} value={entry.value} hint={entry.hint} />
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <TableHeading>{t('usage.byDay')}</TableHeading>
        <TableFrame>
          <DataTable columns={dayColumns(t)} rows={summary.by_day} rowKey={(row) => row.date} />
        </TableFrame>
      </div>

      <div className="flex flex-col gap-2">
        <TableHeading>{t('usage.byModel')}</TableHeading>
        {models.items.length === 0 ? (
          <EmptyState
            title={t('leaderboard.empty.title')}
            description={t('leaderboard.empty.description')}
          />
        ) : (
          <ModelTable items={models.items} t={t} />
        )}
      </div>
    </>
  );
}

export function UsageView({ client, refreshKey, t }: ViewProps) {
  const [range, setRange] = useState<RangeValue>('30');
  const [state, setState] = useState<LoadState<UsageData>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / attempt are explicit refetch triggers.
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    const params = rangeParams(range);
    void Promise.all([
      client.call<SummaryResult>('summary', params),
      client.call<LeaderboardResult>('leaderboard', params),
    ])
      .then(([summary, models]) => {
        if (active) setState({ status: 'ready', data: { summary, models } });
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
    <PluginPage>
      <PluginPageHeader title={t('usage.title')} description={t('usage.description')} />
      <div
        role="toolbar"
        aria-label={t('usage.toolbar')}
        className="flex flex-wrap items-center gap-2"
      >
        <RangeTabs value={range} onChange={setRange} t={t} />
      </div>
      {state.status === 'loading' ? <LoadingState label={t('common.loading')} /> : null}
      {state.status === 'error' ? (
        <ErrorState
          error={state.error}
          onRetry={retry}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      ) : null}
      {state.status === 'ready' ? <UsageBody data={state.data} t={t} /> : null}
    </PluginPage>
  );
}
