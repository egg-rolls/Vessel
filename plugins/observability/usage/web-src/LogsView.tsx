import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  PageScaffold,
  SearchInput,
  Select,
  TableToolbar,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogItem, LogsResult, SourceCoverage } from '../src/aggregate.js';
import { fmtCost, fmtDuration, fmtInt, fmtTime, fmtTimeFull, MISSING } from './format';
import type { Translator } from './i18n';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  TableFrame,
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

function logColumns(t: Translator): readonly DataTableColumn<LogItem>[] {
  return [
    {
      key: 'time',
      header: t('logs.th.time'),
      cell: (row) => <span title={fmtTimeFull(row.ts)}>{fmtTime(row.ts)}</span>,
    },
    {
      key: 'status',
      header: t('logs.th.status'),
      cell: (row) => (
        <Badge tone={row.status === 'failed' ? 'danger' : 'success'}>
          {row.status === 'failed' ? t('common.status.failed') : t('common.status.ok')}
        </Badge>
      ),
    },
    {
      key: 'model',
      header: t('logs.th.model'),
      cell: (row) => <span title={row.model}>{row.model}</span>,
    },
    {
      key: 'session',
      header: t('logs.th.session'),
      cell: (row) => (
        <span className="font-mono text-sm text-muted">{row.session_id ?? MISSING}</span>
      ),
    },
    { key: 'prompt', header: t('logs.th.prompt'), cell: (row) => fmtInt(row.prompt_tokens) },
    {
      key: 'completion',
      header: t('logs.th.completion'),
      cell: (row) => fmtInt(row.completion_tokens),
    },
    {
      key: 'cache_read',
      header: t('logs.th.cacheRead'),
      cell: (row) => fmtInt(row.cache_read_input_tokens),
    },
    { key: 'duration', header: t('logs.th.duration'), cell: (row) => fmtDuration(row.duration_ms) },
    { key: 'cost', header: t('logs.th.cost'), cell: (row) => fmtCost(row.cost) },
  ];
}

export function LogsView({ client, refreshKey, t }: ViewProps) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [pageKey, setPageKey] = useState(0);
  const [items, setItems] = useState<LogItem[]>([]);
  const [cursor, setCursor] = useState<LogsResult['next_cursor']>(null);
  /** Which run files the backend actually read; null until the first page lands. */
  const [source, setSource] = useState<SourceCoverage | null>(null);
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
    setSource(null);

    void client
      .call<LogsResult>('logs', logsParams(applied))
      .then((data) => {
        if (generation.current !== current) return;
        setItems(data.items);
        setCursor(data.next_cursor);
        setSource(data.source ?? null);
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
    <PageScaffold title={t('logs.title')} subtitle={t('logs.description')}>
      <TableToolbar label={t('logs.toolbar')} className="items-end">
        <Field label={t('logs.session')} className="w-44">
          <SearchInput
            value={draft.session}
            onChange={(session) => setDraft((value) => ({ ...value, session }))}
            placeholder={t('logs.sessionPlaceholder')}
            ariaLabel={t('logs.session')}
          />
        </Field>
        <Field label={t('logs.model')} className="w-44">
          <SearchInput
            value={draft.model}
            onChange={(model) => setDraft((value) => ({ ...value, model }))}
            placeholder={t('logs.modelPlaceholder')}
            ariaLabel={t('logs.model')}
          />
        </Field>
        <Field label={t('logs.status')} htmlFor="logs-status" className="w-36">
          <Select
            id="logs-status"
            value={draft.status}
            onChange={(event) => {
              const status = toStatus(event.target.value);
              setDraft((value) => ({ ...value, status }));
            }}
            aria-label={t('logs.status')}
          >
            <option value="">{t('logs.allStatuses')}</option>
            <option value="ok">{t('logs.optionOk')}</option>
            <option value="failed">{t('logs.optionFailed')}</option>
          </Select>
        </Field>
        <Button variant="primary" onClick={applyDraft}>
          {t('common.apply')}
        </Button>
        <Button onClick={reload}>{t('common.refresh')}</Button>
      </TableToolbar>

      {source !== null && source.truncated ? (
        <p className="text-sm text-muted">
          {t('logs.truncated', { files: source.files_read, total: source.files_total })}
        </p>
      ) : null}

      {loading && items.length === 0 ? <LoadingState label={t('common.loading')} /> : null}
      {error !== null && items.length === 0 ? (
        <ErrorState
          error={error}
          onRetry={() => setPageKey((value) => value + 1)}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      ) : null}
      {!loading && error === null && items.length === 0 ? (
        <EmptyState
          title={hasFilters ? t('logs.empty.filtered') : t('logs.empty.title')}
          description={t('logs.empty.description')}
        />
      ) : null}

      {items.length > 0 ? (
        <>
          <TableFrame>
            <DataTable columns={logColumns(t)} rows={items} rowKey={(row) => row.id} />
          </TableFrame>
          {error !== null ? (
            <ErrorState
              error={error}
              onRetry={loadMore}
              title={t('common.loadMoreError')}
              retryLabel={t('common.retry')}
            />
          ) : cursor !== null ? (
            <div>
              <Button variant="primary" onClick={loadMore} disabled={loading}>
                {loading ? t('common.loading') : t('common.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </PageScaffold>
  );
}
