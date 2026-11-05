import {
  Button,
  DataTable,
  type DataTableColumn,
  PluginPage,
  PluginPageHeader,
  Section,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeaderboardResult, ModelBucket } from '../src/aggregate.js';
import { fmtCost, fmtInt } from './format';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  type LoadState,
  RangeTabs,
  type RangeValue,
  rangeParams,
  toError,
  type ViewProps,
} from './shared';

type SortKey = 'model' | 'requests' | 'tokens' | 'cache_read_tokens' | 'cost';
type SortDirection = 'asc' | 'desc';

function sortValue(item: ModelBucket, key: SortKey): number | string | undefined {
  if (key === 'tokens') return (item.prompt_tokens ?? 0) + (item.completion_tokens ?? 0);
  return item[key];
}

function compare(left: number | string | undefined, right: number | string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).localeCompare(String(right));
  }
  return left - right;
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <Button
      variant="chip"
      size="small"
      aria-pressed={active}
      onClick={onClick}
      className="-ml-2.5 font-mono uppercase tracking-wide"
    >
      {active ? `${label} ${direction === 'asc' ? '↑' : '↓'}` : label}
    </Button>
  );
}

export function LeaderboardView({ client, refreshKey, t }: ViewProps) {
  const [range, setRange] = useState<RangeValue>('30');
  const [state, setState] = useState<LoadState<LeaderboardResult>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / attempt are explicit refetch triggers.
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void client
      .call<LeaderboardResult>('leaderboard', rangeParams(range))
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

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDirection((value) => (value === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      setSortDirection(key === 'model' ? 'asc' : 'desc');
    },
    [sortKey],
  );

  const items = state.status === 'ready' ? state.data.items : [];

  const sorted = useMemo(() => {
    const copy = items.slice();
    copy.sort((left, right) => {
      const a = sortValue(left, sortKey);
      const b = sortValue(right, sortKey);
      if (a === undefined || b === undefined) return compare(a, b);
      const result = compare(a, b);
      return sortDirection === 'asc' ? result : -result;
    });
    return copy;
  }, [items, sortKey, sortDirection]);

  const header = useCallback(
    (label: string, key: SortKey) => (
      <SortHeader
        label={label}
        active={sortKey === key}
        direction={sortDirection}
        onClick={() => toggleSort(key)}
      />
    ),
    [sortDirection, sortKey, toggleSort],
  );

  const columns = useMemo((): readonly DataTableColumn<ModelBucket>[] => {
    return [
      {
        key: 'model',
        header: header(t('leaderboard.th.model'), 'model'),
        cell: (row) => <span title={row.model}>{row.model}</span>,
      },
      {
        key: 'requests',
        header: header(t('leaderboard.th.requests'), 'requests'),
        cell: (row) => fmtInt(row.requests),
      },
      {
        key: 'tokens',
        header: header(t('leaderboard.th.tokens'), 'tokens'),
        cell: (row) => fmtInt((row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)),
      },
      {
        key: 'cache_read',
        header: header(t('leaderboard.th.cacheRead'), 'cache_read_tokens'),
        cell: (row) => fmtInt(row.cache_read_tokens),
      },
      {
        key: 'cost',
        header: header(t('leaderboard.th.cost'), 'cost'),
        cell: (row) => fmtCost(row.cost),
      },
    ];
  }, [header, t]);

  return (
    <PluginPage>
      <PluginPageHeader
        title={t('leaderboard.title')}
        description={t('leaderboard.description')}
        actions={<RangeTabs value={range} onChange={setRange} t={t} />}
      />
      {state.status === 'loading' ? <LoadingState label={t('common.loading')} /> : null}
      {state.status === 'error' ? (
        <ErrorState
          error={state.error}
          onRetry={retry}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      ) : null}
      {state.status === 'ready' && sorted.length === 0 ? (
        <EmptyState
          title={t('leaderboard.empty.title')}
          description={t('leaderboard.empty.description')}
        />
      ) : null}
      {sorted.length > 0 ? (
        <Section title={t('leaderboard.section')}>
          <DataTable columns={columns} rows={sorted} rowKey={(row) => row.model} />
        </Section>
      ) : null}
    </PluginPage>
  );
}
