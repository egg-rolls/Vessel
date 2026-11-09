import { DataTable, type DataTableColumn } from '@vessel-agent/plugin-ui';
import { useCallback, useMemo, useState } from 'react';
import type { ModelBucket } from '../src/aggregate.js';
import { fmtCost, fmtInt } from './format';
import type { Translator } from './i18n';
import { TableFrame } from './shared';

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

/** Model leaderboard table; sorting stays local. */
export function ModelTable({ items, t }: { items: readonly ModelBucket[]; t: Translator }) {
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const toggleSort = useCallback(
    (key: string) => {
      const nextKey = key as SortKey;
      if (nextKey === sortKey) {
        setSortDirection((value) => (value === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(nextKey);
      setSortDirection(nextKey === 'model' ? 'asc' : 'desc');
    },
    [sortKey],
  );

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

  const columns = useMemo((): readonly DataTableColumn<ModelBucket>[] => {
    return [
      {
        key: 'model',
        header: t('leaderboard.th.model'),
        sortable: true,
        cell: (row) => <span title={row.model}>{row.model}</span>,
      },
      {
        key: 'requests',
        header: t('leaderboard.th.requests'),
        sortable: true,
        cell: (row) => fmtInt(row.requests),
      },
      {
        key: 'tokens',
        header: t('leaderboard.th.tokens'),
        sortable: true,
        cell: (row) => fmtInt((row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)),
      },
      {
        key: 'cache_read_tokens',
        header: t('leaderboard.th.cacheRead'),
        sortable: true,
        cell: (row) => fmtInt(row.cache_read_tokens),
      },
      {
        key: 'cost',
        header: t('leaderboard.th.cost'),
        sortable: true,
        cell: (row) => fmtCost(row.cost),
      },
    ];
  }, [t]);

  return (
    <TableFrame>
      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(row) => row.model}
        sort={{ key: sortKey, direction: sortDirection }}
        onSortChange={toggleSort}
      />
    </TableFrame>
  );
}
