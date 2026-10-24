import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { SegmentedTabs } from '../../components/Tabs';
import { useToast } from '../../components/ToastProvider';
import { formatTimestamp } from '../../format';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type { DurableRunSummary, RunEvent, RunStatus } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import {
  filterRunEvents,
  groupRunEvents,
  isTraceUnavailable,
  mergeRunEvents,
  nextSinceSeq,
  RUN_EVENT_FILTERS,
  type RunEventFilter,
  type ToolCallGroup,
  traceRunId,
} from '../../state/run-detail';
import { isCancellableRun, isResumableRun } from '../../state/runs';
import { EventRow } from '../chat/EventRow';

const EVENT_PAGE_SIZE = 500;

type DetailTab = 'timeline' | 'output' | 'raw';

const DETAIL_TABS: readonly { id: DetailTab; labelKey: string }[] = [
  { id: 'timeline', labelKey: 'runs.detail.tab.timeline' },
  { id: 'output', labelKey: 'runs.detail.tab.output' },
  { id: 'raw', labelKey: 'runs.detail.tab.raw' },
];

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function durationLabel(start?: number, end?: number): string {
  if (start === undefined) return '—';
  const value = Math.max(0, (end ?? Date.now()) - start);
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function exportJson(data: unknown, runId: string): void {
  const blob = new Blob([pretty(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-${runId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

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
        <span className="mono tool-call-name">{group.name}</span>
        {group.durationMs !== undefined && <span className="dim mono">{group.durationMs}ms</span>}
        <span className="dim tool-call-toggle" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="tool-call-body">
          {group.arguments !== undefined && (
            <div className="tool-call-field">
              <span className="field-label">arguments</span>
              <pre className="json-body">{pretty(group.arguments)}</pre>
            </div>
          )}
          {group.result !== undefined && (
            <div className="tool-call-field">
              <span className="field-label">result</span>
              <pre className="json-body">{pretty(group.result)}</pre>
            </div>
          )}
          {group.error && (
            <div className="tool-call-field">
              <span className="field-label">error</span>
              <pre className="json-body err">{group.error}</pre>
            </div>
          )}
          {group.arguments === undefined && group.result === undefined && !group.error && (
            <p className="section-desc">{t('runs.detail.noToolDetails')}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function RunDetail({
  runId,
  tab,
  run,
  durable,
  active,
  canWrite,
  onCancel,
  onResume,
  onClose,
  busy = false,
}: {
  /** 路由里的 id：live 为引擎 run id，durable 为 checkpoint id。 */
  runId: string;
  tab: 'live' | 'durable';
  run: RunStatus | null;
  durable: DurableRunSummary | null;
  active: boolean;
  canWrite: boolean;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  useLocale();
  const { client, hasToken, connectionState } = useConnection();
  const toast = useToast();
  const snapshot = useEventSnapshot();
  const connected = hasToken && connectionState === 'open';

  const [view, setView] = useState<DetailTab>('timeline');
  const [filter, setFilter] = useState<RunEventFilter>('all');
  const [showInternal, setShowInternal] = useState(false);
  const [typePrefix, setTypePrefix] = useState('');
  const [trace, setTrace] = useState<RunEvent[]>([]);
  const [traceError, setTraceError] = useState<{ code?: string; message: string } | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const previousActive = useRef(active);
  const sectionRef = useRef<HTMLElement | null>(null);
  /** trace 请求代次：切换 run 后旧响应不得覆盖新 run。 */
  const traceGeneration = useRef(0);

  // 实时事件的 run_id 是 core run id；live 列表的 run_id 是 gateway 引擎 id。
  const coreRunId = traceRunId(tab, run, runId, durable?.run_id);

  const liveEvents = useMemo(() => {
    if (!coreRunId) return [];
    return snapshot.entries
      .filter((entry) => entry.event.run_id === coreRunId)
      .map((entry) => entry.event);
  }, [snapshot.entries, coreRunId]);

  const loadFirstPage = useCallback(async () => {
    if (!coreRunId || !hasToken) return;
    traceGeneration.current += 1;
    const generation = traceGeneration.current;
    setTraceLoading(true);
    setTraceError(null);
    try {
      const events = await client.readEvents({ run_id: coreRunId, limit: EVENT_PAGE_SIZE });
      if (generation !== traceGeneration.current) return;
      setTrace(events);
      setHasMore(events.length >= EVENT_PAGE_SIZE);
    } catch (error) {
      if (generation !== traceGeneration.current) return;
      setTrace([]);
      setHasMore(false);
      setTraceError({
        code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (generation === traceGeneration.current) setTraceLoading(false);
    }
  }, [client, coreRunId, hasToken]);

  // 切换 run / 手动重载：重置过滤器与分页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId/coreRunId 变化时重置
  useEffect(() => {
    traceGeneration.current += 1;
    setTrace([]);
    setHasMore(false);
    setTraceError(null);
    setFilter('all');
    setTypePrefix('');
    setView('timeline');
  }, [runId, coreRunId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken 是显式刷新触发器
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, reloadToken]);

  // 活动 run 结束（状态轮询）后补拉一次 trace，避免错过终态前的事件。
  useEffect(() => {
    if (previousActive.current && !active) {
      setReloadToken((value) => value + 1);
    }
    previousActive.current = active;
  }, [active]);

  // 选中 run 后把详情滚入视野（桌面为内联面板；移动端是整页）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId 变化是滚动触发条件
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sectionRef.current?.scrollIntoView({
      block: 'start',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [runId]);

  const events = useMemo(() => mergeRunEvents(trace, liveEvents), [trace, liveEvents]);
  const filtered = useMemo(
    () => filterRunEvents(events, { filter, showInternal, typePrefix }),
    [events, filter, showInternal, typePrefix],
  );
  const items = useMemo(() => groupRunEvents(filtered), [filtered]);
  const sinceSeq = nextSinceSeq(trace);

  const loadMore = async () => {
    if (!coreRunId || sinceSeq === undefined || loadingMore) return;
    const generation = traceGeneration.current;
    setLoadingMore(true);
    try {
      const next = await client.readEvents({
        run_id: coreRunId,
        since_seq: sinceSeq,
        limit: EVENT_PAGE_SIZE,
      });
      if (generation !== traceGeneration.current) return;
      setTrace((prev) => mergeRunEvents(prev, next));
      setHasMore(next.length >= EVENT_PAGE_SIZE);
    } catch (error) {
      if (generation === traceGeneration.current) {
        toast.error(
          t('runs.detail.loadMoreFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } finally {
      if (generation === traceGeneration.current) setLoadingMore(false);
    }
  };

  const status = run?.status ?? durable?.status;
  const sessionId = run?.session_id ?? durable?.session_id;
  const startedAt = run?.started_at;
  const completedAt = run?.completed_at;
  const usage = run?.usage;
  const raw = run ?? durable;
  const lastCheckpointMessage =
    run?.messages && run.messages.length > 0
      ? run.messages[run.messages.length - 1]?.content
      : undefined;
  const cancellable = tab === 'live' && status !== undefined && isCancellableRun(status);
  const resumable = tab === 'durable' && status !== undefined && isResumableRun(status);

  return (
    <section ref={sectionRef} className="panel run-detail" aria-label={t('runs.detail.label')}>
      <div className="panel-header">
        <h2 className="section-title">{t('runs.detail.title')}</h2>
        <StatusChip status={status} />
        <span className="mono dim run-detail-id" title={runId}>
          {runId}
        </span>
        <CopyButton
          text={runId}
          label={t('runs.detail.copyId')}
          toast={t('runs.detail.copiedId')}
        />
        <button type="button" className="btn btn-small" onClick={() => exportJson(raw, runId)}>
          {t('runs.detail.exportJson')}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('runs.detail.close')}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <dl className="diag-list">
        <dt>{t('runs.detail.session')}</dt>
        <dd className="mono">
          {sessionId ? (
            <a className="link-btn mono" href={`#/chat/${encodeURIComponent(sessionId)}`}>
              {sessionId}
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>{t('runs.detail.started')}</dt>
        <dd className="mono">{formatTimestamp(startedAt)}</dd>
        <dt>{t('runs.detail.ended')}</dt>
        <dd className="mono">{formatTimestamp(completedAt)}</dd>
        <dt>{t('runs.detail.duration')}</dt>
        <dd className="mono">{durationLabel(startedAt, completedAt)}</dd>
        {(run?.iteration !== undefined || durable?.iteration !== undefined) && (
          <>
            <dt>Iteration</dt>
            <dd className="mono">{run?.iteration ?? durable?.iteration}</dd>
          </>
        )}
        {(run?.agent_id || durable?.agent_id) && (
          <>
            <dt>Agent</dt>
            <dd className="mono">{run?.agent_id ?? durable?.agent_id}</dd>
          </>
        )}
        {usage && (
          <>
            <dt>Tokens</dt>
            <dd className="mono">
              {usage.prompt_tokens ?? 0} + {usage.completion_tokens ?? 0} ={' '}
              {usage.total_tokens ?? 0}
            </dd>
          </>
        )}
      </dl>

      <div className="run-detail-actions">
        {cancellable && (
          <button
            type="button"
            className="btn btn-small btn-danger-ghost"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onCancel(runId)}
          >
            {busy ? t('runs.detail.cancelling') : t('runs.detail.cancel')}
          </button>
        )}
        {resumable && (
          <button
            type="button"
            className="btn btn-small"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onResume(runId)}
          >
            {busy ? t('runs.detail.resuming') : t('runs.detail.resume')}
          </button>
        )}
      </div>

      {!connected && (
        <StaleNotice message={t('runs.detail.disconnected')} onRetry={loadFirstPage} />
      )}

      <SegmentedTabs
        label={t('runs.detail.tabsLabel')}
        tabs={DETAIL_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }))}
        value={view}
        onChange={setView}
        panelId="run-detail-panel"
      />

      {view === 'timeline' && (
        <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.timelineLabel')}>
          <div className="filter-bar">
            <fieldset className="filter-chips">
              <legend className="sr-only">{t('runs.detail.filtersLabel')}</legend>
              {RUN_EVENT_FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`filter-chip ${filter === item.id ? 'active' : ''}`.trim()}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </fieldset>
            <input
              className="input input-compact mono"
              value={typePrefix}
              onChange={(event) => setTypePrefix(event.target.value)}
              placeholder={t('runs.detail.typePrefix')}
              aria-label={t('runs.detail.typePrefixLabel')}
              spellCheck={false}
            />
            <button
              type="button"
              className={`btn btn-small ${showInternal ? 'active' : ''}`.trim()}
              aria-pressed={showInternal}
              onClick={() => setShowInternal((value) => !value)}
            >
              {t('runs.detail.showInternal')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => void loadFirstPage()}>
              {t('runs.detail.refreshEvents')}
            </button>
            <span className="count-pill">
              {filtered.length}/{events.length}
            </span>
          </div>

          {traceError && events.length === 0 ? (
            isTraceUnavailable(traceError) ? (
              <NotEnabledState
                title={t('runs.detail.traceDisabledTitle')}
                reason={traceError.message}
                hint={t('runs.detail.traceDisabledHint')}
              />
            ) : (
              <ErrorState message={traceError.message} onRetry={() => void loadFirstPage()} />
            )
          ) : (
            <>
              {traceError && (
                <StaleNotice
                  message={t('runs.detail.traceStale', { count: liveEvents.length })}
                  onRetry={() => void loadFirstPage()}
                />
              )}
              {traceLoading && events.length === 0 ? (
                <LoadingState label={t('runs.detail.loadingTrace')} />
              ) : events.length === 0 ? (
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
                  description={t('runs.detail.noMatchDesc')}
                />
              ) : (
                <div className="event-list">
                  {items.map((item) =>
                    item.kind === 'tool' ? (
                      <ToolCallRow key={item.key} group={item} />
                    ) : (
                      <EventRow key={item.key} event={item.event} />
                    ),
                  )}
                </div>
              )}

              {hasMore && (
                <div className="load-more-row">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={loadingMore || sinceSeq === undefined}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore
                      ? t('runs.detail.loadingMore')
                      : t('runs.detail.loadMore', { count: trace.length })}
                  </button>
                  {sinceSeq === undefined && (
                    <span className="dim">{t('runs.detail.missingSeq')}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === 'output' && (
        <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.outputLabel')}>
          {run?.error && (
            <>
              <h3 className="section-title">{t('runs.detail.errorTitle')}</h3>
              <pre className="run-output err">{run.error}</pre>
            </>
          )}
          {run?.output ? (
            <>
              <h3 className="section-title">{t('runs.detail.outputTitle')}</h3>
              <pre className="run-output">{run.output}</pre>
            </>
          ) : durable?.preview ? (
            <>
              <h3 className="section-title">{t('runs.detail.checkpointPreview')}</h3>
              <pre className="run-output">{durable.preview}</pre>
            </>
          ) : lastCheckpointMessage ? (
            <>
              <h3 className="section-title">{t('runs.detail.checkpoint')}</h3>
              <pre className="run-output">{lastCheckpointMessage}</pre>
            </>
          ) : (
            <EmptyState
              title={t('runs.detail.emptyOutputTitle')}
              description={t('runs.detail.emptyOutputDesc')}
            />
          )}
        </div>
      )}

      {view === 'raw' && (
        <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.rawLabel')}>
          {raw ? (
            <>
              <div className="form-actions">
                <CopyButton
                  text={pretty(raw)}
                  label={t('runs.detail.copyJson')}
                  toast={t('runs.detail.copiedJson')}
                  className="btn btn-small"
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => exportJson(raw, runId)}
                >
                  {t('runs.detail.exportJson')}
                </button>
              </div>
              <JsonView value={raw} label={t('runs.detail.rawJsonLabel')} open maxHeight={520} />
            </>
          ) : (
            <LoadingState label={t('runs.detailLoading')} />
          )}
        </div>
      )}
    </section>
  );
}
