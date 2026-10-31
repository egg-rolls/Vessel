/**
 * RunDetail 的 timeline 面板：事件过滤、tool call 合并行与分页加载更多。
 *
 * 数据/状态由 useRunTrace 提供；本组件只负责渲染。
 */

import { useState } from 'react';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Badge, Button, Input } from '../../components/ui';
import { t } from '../../i18n';
import { isTraceUnavailable, RUN_EVENT_FILTERS, type ToolCallGroup } from '../../state/run-detail';
import { EventRow } from '../chat/EventRow';
import { pretty } from './run-detail-format';
import type { RunTrace } from './useRunTrace';

function ToolCallRow({ group }: { group: ToolCallGroup }) {
  const [open, setOpen] = useState(group.status === 'failed');
  const chip =
    group.status === 'failed' ? 'failed' : group.status === 'completed' ? 'completed' : 'running';
  const label =
    group.status === 'failed'
      ? t('runs.detail.tool.failed')
      : group.status === 'completed'
        ? t('runs.detail.tool.completed')
        : t('runs.detail.tool.running');
  return (
    <div className={`tool-call ${group.status}`}>
      <button
        type="button"
        className="tool-call-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusChip status={chip} label={label} />
        <span className="font-mono tool-call-name">{group.name}</span>
        {group.durationMs !== undefined && (
          <span className="font-mono text-muted">{group.durationMs}ms</span>
        )}
        <span className="text-muted tool-call-toggle" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="tool-call-body">
          {group.arguments !== undefined && (
            <div className="tool-call-field">
              <span className="font-mono text-2xs uppercase tracking-widest text-faint">
                arguments
              </span>
              <pre className="json-body">{pretty(group.arguments)}</pre>
            </div>
          )}
          {group.result !== undefined && (
            <div className="tool-call-field">
              <span className="font-mono text-2xs uppercase tracking-widest text-faint">
                result
              </span>
              <pre className="json-body">{pretty(group.result)}</pre>
            </div>
          )}
          {group.error && (
            <div className="tool-call-field">
              <span className="font-mono text-2xs uppercase tracking-widest text-faint">error</span>
              <pre className="json-body text-danger">{group.error}</pre>
            </div>
          )}
          {group.arguments === undefined && group.result === undefined && !group.error && (
            <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
              {t('runs.detail.noToolDetails')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function RunTimeline({
  trace,
  tab,
  coreRunId,
}: {
  trace: RunTrace;
  tab: 'live' | 'durable';
  coreRunId?: string;
}) {
  return (
    <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.timelineLabel')}>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('runs.detail.filtersLabel')}</legend>
          {RUN_EVENT_FILTERS.map((item) => (
            <Button
              key={item.id}
              variant="chip"
              size="small"
              aria-pressed={trace.filter === item.id}
              onClick={() => trace.setFilter(item.id)}
            >
              {t(item.labelKey)}
            </Button>
          ))}
        </fieldset>
        <Input
          className="w-auto max-w-56 px-2.25 py-1.25 text-xs font-mono"
          value={trace.typePrefix}
          onChange={(event) => trace.setTypePrefix(event.target.value)}
          placeholder={t('runs.detail.typePrefix')}
          aria-label={t('runs.detail.typePrefixLabel')}
          spellCheck={false}
        />
        <Button
          size="small"
          className="aria-pressed:bg-accent-soft aria-pressed:text-accent-ink"
          aria-pressed={trace.showInternal}
          onClick={() => trace.setShowInternal((value) => !value)}
        >
          {t('runs.detail.showInternal')}
        </Button>
        <Button size="small" onClick={() => void trace.loadFirstPage()}>
          {t('runs.detail.refreshEvents')}
        </Button>
        <Badge>
          {trace.filtered.length}/{trace.events.length}
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
          ) : trace.events.length === 0 ? (
            <EmptyState
              title={t('runs.detail.emptyTraceTitle')}
              description={
                tab === 'live' && !coreRunId
                  ? t('runs.detail.emptyTraceQueued')
                  : t('runs.detail.emptyTraceDesc')
              }
            />
          ) : trace.filtered.length === 0 ? (
            <EmptyState
              title={t('runs.detail.noMatchTitle')}
              description={t('runs.detail.noMatchDesc')}
            />
          ) : (
            <div className="mt-2 flex max-h-105 flex-col gap-1 overflow-y-auto rounded-md bg-sunken px-2.5 py-1.5">
              {trace.items.map((item) =>
                item.kind === 'tool' ? (
                  <ToolCallRow key={item.key} group={item} />
                ) : (
                  <EventRow key={item.key} event={item.event} />
                ),
              )}
            </div>
          )}

          {trace.hasMore && (
            <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm">
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
