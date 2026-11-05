import { Button, DataTable, type DataTableColumn } from '@vessel-agent/plugin-ui';
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

/** Model leaderboard table; sorting stays local. */
export function ModelTable({ items, t }: { items: readonly ModelBucket[]; t: Translator }) {
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

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
    <TableFrame>
      <DataTable columns={columns} rows={sorted} rowKey={(row) => row.model} />
    </TableFrame>
  );
}
