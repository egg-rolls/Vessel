import {
  DataTable,
  type DataTableColumn,
  PageScaffold,
  Stat,
  TableToolbar,
  useStaleWhileRevalidate,
} from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import type { DayBucket, LeaderboardResult, SummaryResult } from '../src/aggregate.js';
import { costHint, fmtCost, fmtInt, fmtPct, fmtTimeFull, ratioHint } from './format';
import type { Translator } from './i18n';
import { ModelTable } from './ModelTable';
import {
  CoverageNotice,
  EmptyState,
  ErrorState,
  LoadingState,
  RangeTabs,
  type RangeValue,
  RefreshingHint,
  rangeParams,
  StaleNotice,
  TableFrame,
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
    // 0.56: with a retired source, do NOT say "no usage yet" — that turns "cannot be
    // computed" into "you never used it". CoverageNotice above states the real reason.
    if (summary.source?.source_retired === true) return null;
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

/** 后台轮询间隔（用户裁定：usage 15s SWR——保留旧数据后台刷新，不整页 loading）。 */
const USAGE_POLL_MS = 15_000;

export function UsageView({ client, refreshKey, t }: ViewProps) {
  const [range, setRange] = useState<RangeValue>('30');
  // SWR（docs/architecture/data-refresh-swr.md）：range 是查询身份（切换 = 新查询，
  // 首次 loading）；refreshKey / 15s 轮询是 revalidate（保留旧数据，就绪无缝替换）。
  const swr = useStaleWhileRevalidate<UsageData>({
    load: async () => {
      const params = rangeParams(range);
      const [summary, models] = await Promise.all([
        client.call<SummaryResult>('summary', params),
        client.call<LeaderboardResult>('leaderboard', params),
      ]);
      return { summary, models };
    },
    queryKey: [range],
    intervalMs: USAGE_POLL_MS,
    refreshKey,
  });

  return (
    <PageScaffold title={t('usage.title')} subtitle={t('usage.description')}>
      <TableToolbar label={t('usage.toolbar')}>
        <RangeTabs value={range} onChange={setRange} t={t} />
        {swr.isRefreshing ? <RefreshingHint label={t('common.updating')} /> : null}
      </TableToolbar>
      {/* The totals below are only as complete as the reader's coverage of the
          selected range; say so instead of presenting a partial sum as the
          total. Same component (and copy) as the Logs page. */}
      {swr.data !== undefined ? <CoverageNotice source={swr.data.summary.source} t={t} /> : null}
      {swr.isLoading ? <LoadingState label={t('common.loading')} /> : null}
      {swr.error !== undefined && swr.data === undefined ? (
        <ErrorState
          error={swr.error}
          onRetry={swr.reload}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      ) : null}
      {/* 刷新失败但旧数据仍在：细微 stale 提示 + 重试，绝不撤掉数据（SWR 条款 2）。 */}
      {swr.error !== undefined && swr.data !== undefined ? (
        <StaleNotice
          message={t('common.stale', { time: fmtTimeFull(swr.updatedAt) })}
          onRetry={swr.reload}
          retryLabel={t('common.retry')}
        />
      ) : null}
      {swr.data !== undefined ? <UsageBody data={swr.data} t={t} /> : null}
    </PageScaffold>
  );
}
