import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  SearchInput,
  Section,
  Select,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogItem, LogsResult } from '../src/aggregate.js';
import { fmtCost, fmtDuration, fmtInt, fmtTime, MISSING } from './format';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  toError,
  type ViewProps,
} from './shared';

const LOG_LIMIT = 50;

type StatusFilter = '' | 'ok' | 'failed';

interface Filters {
  session: string;
  model: string;
  status: StatusFilter;
}

const EMPTY_FILTERS: Filters = { session: '', model: '', status: '' };

function logsParams(filters: Filters): Record<string, unknown> {
  const params: Record<string, unknown> = { limit: LOG_LIMIT };
  const session = filters.session.trim();
  const model = filters.model.trim();
  if (session !== '') params.session_id = session;
  if (model !== '') params.model = model;
  if (filters.status !== '') params.status = filters.status;
  return params;
}

function toStatus(value: string): StatusFilter {
  return value === 'ok' || value === 'failed' ? value : '';
}

const LOG_COLUMNS: readonly DataTableColumn<LogItem>[] = [
  { key: 'time', header: 'Time', cell: (row) => fmtTime(row.ts) },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <Badge tone={row.status === 'failed' ? 'danger' : 'success'}>{row.status}</Badge>
    ),
  },
  { key: 'model', header: 'Model', cell: (row) => <span title={row.model}>{row.model}</span> },
  {
    key: 'session',
    header: 'Session',
    cell: (row) => (
      <span className="font-mono text-sm text-muted">{row.session_id ?? MISSING}</span>
    ),
  },
  { key: 'prompt', header: 'Prompt', cell: (row) => fmtInt(row.prompt_tokens) },
  { key: 'completion', header: 'Completion', cell: (row) => fmtInt(row.completion_tokens) },
  {
    key: 'cache_read',
    header: 'Cache read',
    cell: (row) => fmtInt(row.cache_read_input_tokens),
  },
  { key: 'duration', header: 'Duration', cell: (row) => fmtDuration(row.duration_ms) },
  { key: 'cost', header: 'Cost', cell: (row) => fmtCost(row.cost) },
];

export function LogsView({ client, refreshKey }: ViewProps) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [pageKey, setPageKey] = useState(0);
  const [items, setItems] = useState<LogItem[]>([]);
  const [cursor, setCursor] = useState<LogsResult['next_cursor']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / pageKey are explicit refetch triggers.
  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    setLoading(true);
    setError(null);
    setItems([]);
    setCursor(null);

    void client
      .call<LogsResult>('logs', logsParams(applied))
      .then((data) => {
        if (generation.current !== current) return;
        setItems(data.items);
        setCursor(data.next_cursor);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (generation.current !== current) return;
        setError(toError(reason));
        setLoading(false);
      });
  }, [client, applied, refreshKey, pageKey]);

  const reload = useCallback(() => {
    setApplied((value) => ({ ...value }));
  }, []);

  const applyDraft = useCallback(() => {
    setApplied({ ...draft });
  }, [draft]);

  const loadMore = useCallback(() => {
    if (cursor === null || loading) return;
    const current = generation.current;
    setLoading(true);
    setError(null);
    const params = {
      ...logsParams(applied),
      before_ts: cursor.before_ts,
      before_id: cursor.before_id,
    };
    void client
      .call<LogsResult>('logs', params)
      .then((data) => {
        if (generation.current !== current) return;
        setItems((previous) => [...previous, ...data.items]);
        setCursor(data.next_cursor);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (generation.current !== current) return;
        setError(toError(reason));
        setLoading(false);
      });
  }, [applied, client, cursor, loading]);

  const hasFilters =
    applied.session.trim() !== '' || applied.model.trim() !== '' || applied.status !== '';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Logs"
        description="One row per LLM response, plus failed runs."
        actions={
          <>
            <Field label="Session" className="w-44">
              <SearchInput
                value={draft.session}
                onChange={(session) => setDraft((value) => ({ ...value, session }))}
                placeholder="Session id"
                ariaLabel="Session id"
              />
            </Field>
            <Field label="Model" className="w-44">
              <SearchInput
                value={draft.model}
                onChange={(model) => setDraft((value) => ({ ...value, model }))}
                placeholder="Model"
                ariaLabel="Model"
              />
            </Field>
            <Field label="Status" htmlFor="logs-status" className="w-36">
              <Select
                id="logs-status"
                value={draft.status}
                onChange={(event) => {
                  const status = toStatus(event.target.value);
                  setDraft((value) => ({ ...value, status }));
                }}
                aria-label="Status"
              >
                <option value="">All statuses</option>
                <option value="ok">OK</option>
                <option value="failed">Failed</option>
              </Select>
            </Field>
            <Button variant="primary" onClick={applyDraft}>
              Apply
            </Button>
            <Button onClick={reload}>Refresh</Button>
          </>
        }
      />

      {loading && items.length === 0 ? <LoadingState /> : null}
      {error !== null && items.length === 0 ? (
        <ErrorState error={error} onRetry={() => setPageKey((value) => value + 1)} />
      ) : null}
      {!loading && error === null && items.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No matching requests' : 'No request logs yet'}
          description="Logs are read from the persisted tenant event files."
        />
      ) : null}

      {items.length > 0 ? (
        <>
          <Section title="Request log">
            <DataTable columns={LOG_COLUMNS} rows={items} rowKey={(row) => row.id} />
          </Section>
          {error !== null ? (
            <ErrorState error={error} onRetry={loadMore} title="Could not load more logs" />
          ) : cursor !== null ? (
            <div>
              <Button variant="primary" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
