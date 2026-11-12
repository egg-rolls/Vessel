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
  CoverageNotice,
  EmptyState,
  ErrorState,
  LoadingState,
  RangeTabs,
  type RangeValue,
  rangeParams,
  TableFrame,
  toError,
  type ViewProps,
} from './shared';

const LOG_LIMIT = 50;

type StatusFilter = '' | 'ok' | 'failed';

/** An explicit `[from, until)` interval, as the two `datetime-local` inputs hold it. */
interface CustomRange {
  from: string;
  to: string;
}

interface Filters {
  session: string;
  model: string;
  status: StatusFilter;
  /** Preset range; ignored when `custom` is set (the RPC rejects both at once). */
  range: RangeValue;
  custom: CustomRange | null;
}

/**
 * The range the Logs page opens on: last 7 days.
 *
 * Logs are the highest-volume view (one row per request), so the page starts
 * scoped instead of on "all time"; the tab row still offers "All time" in one
 * click. Usage keeps its own default — this constant is Logs-only.
 */
const DEFAULT_RANGE: RangeValue = '7';

const EMPTY_FILTERS: Filters = {
  session: '',
  model: '',
  status: '',
  range: DEFAULT_RANGE,
  custom: null,
};

/** `datetime-local` value -> ms epoch (interpreted in the user's local zone). */
function toEpoch(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** The preset label for a tab value, without relying on template-literal keys. */
function rangeLabel(t: Translator, range: RangeValue): string {
  switch (range) {
    case '1':
      return t('range.1');
    case '7':
      return t('range.7');
    case '30':
      return t('range.30');
    case '90':
      return t('range.90');
    default:
      return t('range.0');
  }
}

/**
 * RPC params for the current selection.
 *
 * `days` and `since`/`until` are two ways to name one range and the backend
 * rejects both together, so a custom interval replaces the preset entirely
 * instead of narrowing it.
 */
function logsParams(filters: Filters): Record<string, unknown> {
  const params: Record<string, unknown> = { limit: LOG_LIMIT };
  if (filters.custom !== null) {
    const since = toEpoch(filters.custom.from);
    const until = toEpoch(filters.custom.to);
    if (since !== undefined) params.since = since;
    if (until !== undefined) params.until = until;
  } else {
    Object.assign(params, rangeParams(filters.range));
  }
  const session = filters.session.trim();
  const model = filters.model.trim();
  if (session !== '') params.session_id = session;
  if (model !== '') params.model = model;
  if (filters.status !== '') params.status = filters.status;
  return params;
}

/** `true` when the interval cannot be sent (nothing filled in, or inverted). */
function customInvalid(custom: CustomRange): boolean {
  const since = toEpoch(custom.from);
  const until = toEpoch(custom.to);
  if (since === undefined && until === undefined) return true;
  if (custom.from.trim() !== '' && since === undefined) return true;
  if (custom.to.trim() !== '' && until === undefined) return true;
  return since !== undefined && until !== undefined && since >= until;
}

function toStatus(value: string): StatusFilter {
  return value === 'ok' || value === 'failed' ? value : '';
}

/** A `datetime-local` control; the plugin-ui package has no date input. */
function DateTimeInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} className="w-52">
      <input
        id={id}
        type="datetime-local"
        className="h-control w-full min-w-0 rounded-sm border-0 bg-sunken px-3 text-sm text-ink shadow-elev-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      />
    </Field>
  );
}

/**
 * "What am I looking at, and how much of it is loaded."
 *
 * The toolbar holds the *draft* filter values (they only take effect on Apply),
 * so the applied range and conditions are spelled out here — otherwise a user
 * who typed a model and did not press Apply would read the row count as that
 * model's.
 */
function StateLine({
  applied,
  loaded,
  cursor,
  t,
}: {
  applied: Filters;
  loaded: number;
  cursor: LogsResult['next_cursor'];
  t: Translator;
}) {
  const range =
    applied.custom !== null
      ? t('logs.state.custom', {
          from: applied.custom.from === '' ? '…' : applied.custom.from,
          to: applied.custom.to === '' ? '…' : applied.custom.to,
        })
      : rangeLabel(t, applied.range);
  const conditions: string[] = [];
  const model = applied.model.trim();
  const session = applied.session.trim();
  if (model !== '') conditions.push(`${t('logs.model')}: ${model}`);
  if (session !== '') conditions.push(`${t('logs.session')}: ${session}`);
  if (applied.status !== '') {
    conditions.push(
      `${t('logs.status')}: ${
        applied.status === 'ok' ? t('logs.optionOk') : t('logs.optionFailed')
      }`,
    );
  }
  const count = `${t('logs.state.loaded', { n: loaded })} · ${
    cursor === null ? t('logs.state.end') : t('logs.state.more')
  }`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>{t('logs.state.range', { range })}</span>
      <span>{count}</span>
      {conditions.length > 0 ? (
        <span>{t('logs.state.conditions', { conditions: conditions.join(' · ') })}</span>
      ) : null}
    </div>
  );
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
  /** The typed interval cannot be sent (empty or inverted); nothing was applied. */
  const [rangeInvalid, setRangeInvalid] = useState(false);
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

  /**
   * Session / model / status take effect on Apply; the range does not wait for
   * it (a scope is obviously meant to be taken, and the tab must react at once).
   */
  const applyDraft = useCallback(() => {
    const customIsBad = draft.custom !== null && customInvalid(draft.custom);
    setRangeInvalid(customIsBad);
    // A half-typed interval must not be sent: keep the previously applied one.
    setApplied({ ...draft, custom: customIsBad ? applied.custom : draft.custom });
  }, [applied.custom, draft]);

  const applyRange = useCallback((next: RangeValue) => {
    setRangeInvalid(false);
    setDraft((value) => ({ ...value, range: next, custom: null }));
    setApplied((value) => ({ ...value, range: next, custom: null }));
  }, []);

  const editCustom = useCallback((patch: Partial<CustomRange>) => {
    setRangeInvalid(false);
    setDraft((value) => ({ ...value, custom: { from: '', to: '', ...value.custom, ...patch } }));
  }, []);

  const applyCustom = useCallback(() => {
    const custom = draft.custom ?? { from: '', to: '' };
    if (customInvalid(custom)) {
      setRangeInvalid(true);
      return;
    }
    setRangeInvalid(false);
    const next: Filters = { ...draft, custom };
    setDraft(next);
    setApplied(next);
  }, [draft]);

  const clearCustom = useCallback(() => {
    setRangeInvalid(false);
    setDraft((value) => ({ ...value, custom: null }));
    setApplied((value) => ({ ...value, custom: null }));
  }, []);

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

  // The default range is not a "filter": an empty first load should say "no logs
  // yet", not "no matching requests".
  const hasFilters =
    applied.session.trim() !== '' ||
    applied.model.trim() !== '' ||
    applied.status !== '' ||
    applied.custom !== null ||
    applied.range !== DEFAULT_RANGE;

  return (
    <PageScaffold title={t('logs.title')} subtitle={t('logs.description')}>
      <TableToolbar label={t('logs.toolbar')} className="items-end">
        {draft.custom === null ? (
          <RangeTabs value={draft.range} onChange={applyRange} t={t} />
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted">
              {t('logs.state.custom', {
                from: draft.custom.from === '' ? '…' : draft.custom.from,
                to: draft.custom.to === '' ? '…' : draft.custom.to,
              })}
            </span>
            <Button onClick={clearCustom}>{t('range.clear')}</Button>
          </div>
        )}
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

      <details className="flex flex-col gap-2">
        <summary className="cursor-pointer font-mono text-2xs uppercase tracking-widest text-faint">
          {t('range.custom')}
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <DateTimeInput
            id="logs-range-from"
            label={t('range.from')}
            value={draft.custom?.from ?? ''}
            onChange={(from) => editCustom({ from })}
          />
          <DateTimeInput
            id="logs-range-to"
            label={t('range.to')}
            value={draft.custom?.to ?? ''}
            onChange={(to) => editCustom({ to })}
          />
          <Button variant="primary" onClick={applyCustom}>
            {t('range.apply')}
          </Button>
          {rangeInvalid ? <p className="text-sm text-danger">{t('range.invalid')}</p> : null}
        </div>
      </details>

      <StateLine applied={applied} loaded={items.length} cursor={cursor} t={t} />

      <CoverageNotice source={source} t={t} />

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
