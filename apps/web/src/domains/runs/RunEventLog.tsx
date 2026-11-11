/**
 * 运行详情的「原始事件日志」：一行一事件，可展开完整 JSON。
 *
 * 与聊天时间线刻意不同：这里不折叠 tool call、不生成工具卡 / notice 卡 ——
 * 详情页是查日志的面，一行一事件才好比对 seq、抄时间戳、搜载荷。
 * 数据与取数分页由 useRunTrace 提供，本组件只做渲染与内存内过滤 / 分页。
 */

import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { Badge, Button, cn, Input } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { t } from '../../i18n';
import { isErrorEventType } from '../../state/error-visibility';
import { isTraceUnavailable, RUN_EVENT_FILTERS, type RunEventFilter } from '../../state/run-detail';
import { pretty } from './run-detail-format';
import { buildLogRows, eventLogWindow, filterLogRows, parseSeqInput } from './run-event-log';
import type { RunTrace } from './useRunTrace';

/** 行网格：窄屏堆叠，宽屏一行的四列（时间戳 / seq / type / 摘要）。 */
const ROW_CLASS =
  'grid w-full grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-left font-mono text-xs tint-hover tint-press wide:grid-cols-[11.5rem_4.5rem_minmax(8rem,15rem)_minmax(0,1fr)] wide:items-baseline';

const HEAD_CLASS =
  'hidden grid-cols-[11.5rem_4.5rem_minmax(8rem,15rem)_minmax(0,1fr)] gap-x-3 px-2.5 py-1.5 font-mono text-2xs tracking-widest text-faint uppercase wide:grid';

const FILTER_INPUT_CLASS = 'w-auto px-2.25 py-1.25 text-xs font-mono';

export function RunEventLog({
  trace,
  tab,
  coreRunId,
}: {
  trace: RunTrace;
  tab: 'live' | 'durable';
  coreRunId?: string;
}) {
  const [category, setCategory] = useState<RunEventFilter>('all');
  const [typePrefix, setTypePrefix] = useState('');
  const [seqFrom, setSeqFrom] = useState('');
  const [seqTo, setSeqTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(() => buildLogRows(trace.events), [trace.events]);
  const filter = useMemo(
    () => ({
      category,
      typePrefix,
      keyword,
      fromSeq: parseSeqInput(seqFrom),
      toSeq: parseSeqInput(seqTo),
    }),
    [category, typePrefix, keyword, seqFrom, seqTo],
  );
  const filtered = useMemo(() => filterLogRows(rows, filter), [rows, filter]);
  const view = useMemo(() => eventLogWindow(filtered, page), [filtered, page]);

  // 过滤条件变化后回到第 1 页：否则会停在越界页码上看到空白。
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter 变化是重置条件
  useEffect(() => {
    setPage(1);
  }, [filter]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('runs.detail.filtersLabel')}</legend>
          {RUN_EVENT_FILTERS.map((item) => (
            <Button
              key={item.id}
              variant="chip"
              size="small"
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {t(item.labelKey)}
            </Button>
          ))}
        </fieldset>
        <Input
          className={cn(FILTER_INPUT_CLASS, 'max-w-56')}
          value={typePrefix}
          onChange={(event) => setTypePrefix(event.target.value)}
          placeholder={t('runs.detail.typePrefix')}
          aria-label={t('runs.detail.typePrefixLabel')}
          spellCheck={false}
        />
        <Input
          className={cn(FILTER_INPUT_CLASS, 'max-w-20')}
          value={seqFrom}
          onChange={(event) => setSeqFrom(event.target.value)}
          placeholder="seq ≥"
          aria-label={t('runs.log.seqFrom')}
          inputMode="numeric"
          spellCheck={false}
        />
        <Input
          className={cn(FILTER_INPUT_CLASS, 'max-w-20')}
          value={seqTo}
          onChange={(event) => setSeqTo(event.target.value)}
          placeholder="seq ≤"
          aria-label={t('runs.log.seqTo')}
          inputMode="numeric"
          spellCheck={false}
        />
        <Input
          className={cn(FILTER_INPUT_CLASS, 'max-w-64 grow basis-40')}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('runs.log.keyword')}
          aria-label={t('runs.log.keywordLabel')}
          spellCheck={false}
        />
        <Button size="small" onClick={() => void trace.loadFirstPage()}>
          {t('runs.detail.refreshEvents')}
        </Button>
        <Badge>
          <span className="tabular-nums">
            {filtered.length}/{rows.length}
          </span>
        </Badge>
      </div>

      {trace.traceError && trace.events.length === 0 ? (
        isTraceUnavailable(trace.traceError) ? (
          <NotEnabledState
            title={t('runs.detail.traceDisabledTitle')}
            reason={trace.traceError.message}
            hint={t('runs.detail.traceDisabledHint')}
          />
        ) : (
          <ErrorState
            message={trace.traceError.message}
            onRetry={() => void trace.loadFirstPage()}
          />
        )
      ) : (
        <>
          {trace.traceError && (
            <StaleNotice
              message={t('runs.detail.traceStale', { count: trace.liveEvents.length })}
              onRetry={() => void trace.loadFirstPage()}
            />
          )}
          {trace.traceLoading && trace.events.length === 0 ? (
            <LoadingState label={t('runs.detail.loadingTrace')} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('runs.detail.emptyTraceTitle')}
              description={
                tab === 'live' && !coreRunId
                  ? t('runs.detail.emptyTraceQueued')
                  : t('runs.detail.emptyTraceDesc')
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={t('runs.detail.noMatchTitle')}
              description={t('runs.log.noMatchDesc')}
            />
          ) : (
            <>
              <div className="mt-2 overflow-hidden rounded-md bg-sunken">
                <div className={HEAD_CLASS}>
                  <span>{t('runs.log.col.time')}</span>
                  <span>seq</span>
                  <span>{t('runs.log.col.type')}</span>
                  <span>{t('runs.log.col.summary')}</span>
                </div>
                <ul className="m-0 flex list-none flex-col p-0">
                  {view.rows.map((row) => {
                    const open = expanded.has(row.key);
                    const clock = formatTimestamp(row.event.ts, { withMs: true });
                    const json = open ? pretty(row.event) : '';
                    return (
                      <li key={row.key} className="border-t border-line first:border-t-0">
                        <button
                          type="button"
                          className={ROW_CLASS}
                          aria-expanded={open}
                          aria-label={t('runs.log.rowLabel', {
                            type: row.event.type,
                            seq: row.event.seq ?? '—',
                          })}
                          onClick={() => toggle(row.key)}
                        >
                          <span className="text-muted tabular-nums">
                            <span className="block">{clock === '' ? '—' : clock}</span>
                            <span className="block text-2xs text-faint">{row.event.ts}</span>
                          </span>
                          <span className="text-faint tabular-nums">{row.event.seq ?? '—'}</span>
                          <span
                            className={cn(
                              'wrap-anywhere',
                              isErrorEventType(row.event.type) ? 'text-danger' : 'text-ink',
                            )}
                          >
                            {row.event.type}
                          </span>
                          <span className="truncate text-muted">{row.summary}</span>
                        </button>
                        {open && (
                          <div className="border-t border-line bg-deep px-2.5 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-2xs text-faint uppercase">
                                event json
                              </span>
                              <CopyButton
                                text={json}
                                label={t('runs.detail.copyJson')}
                                toast={t('runs.detail.copiedJson')}
                              />
                            </div>
                            <pre className="json-body mt-1.5 rounded-sm bg-sunken">{json}</pre>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm">
                {view.pageCount > 1 && (
                  <>
                    <Button
                      size="small"
                      disabled={view.page <= 1}
                      onClick={() => setPage(view.page - 1)}
                    >
                      {t('runs.log.prev')}
                    </Button>
                    <span className="text-muted tabular-nums">
                      {t('runs.log.pageOf', { page: view.page, pages: view.pageCount })}
                    </span>
                    <Button
                      size="small"
                      disabled={view.page >= view.pageCount}
                      onClick={() => setPage(view.page + 1)}
                    >
                      {t('runs.log.next')}
                    </Button>
                  </>
                )}
                {trace.hasMore && (
                  <>
                    <Button
                      size="small"
                      disabled={trace.loadingMore || trace.sinceSeq === undefined}
                      onClick={() => void trace.loadMore()}
                    >
                      {trace.loadingMore
                        ? t('runs.detail.loadingMore')
                        : t('runs.detail.loadMore', { count: trace.trace.length })}
                    </Button>
                    {trace.sinceSeq === undefined && (
                      <span className="text-muted">{t('runs.detail.missingSeq')}</span>
                    )}
                    <span className="text-muted">{t('runs.log.loadedOnly')}</span>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
