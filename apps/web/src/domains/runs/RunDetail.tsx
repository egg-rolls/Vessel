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
import { Badge, Button, Input, KeyValueList, Section } from '../../components/ui';
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
    document.querySelector<HTMLElement>('.run-detail')?.scrollIntoView({
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
    <Section
      className="run-detail"
      aria-label={t('runs.detail.label')}
      title={t('runs.detail.title')}
      actions={
        <>
          <StatusChip status={status} />
          <span className="min-w-0 wrap-anywhere font-mono text-muted" title={runId}>
            {runId}
          </span>
          <CopyButton
            text={runId}
            label={t('runs.detail.copyId')}
            toast={t('runs.detail.copiedId')}
            className="ml-auto"
          />
          <Button size="small" onClick={() => exportJson(raw, runId)}>
            {t('runs.detail.exportJson')}
          </Button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('runs.detail.close')}
            onClick={onClose}
          >
            ×
          </button>
        </>
      }
    >
      <KeyValueList
        items={[
          {
            key: 'session',
            label: t('runs.detail.session'),
            value: sessionId ? (
              <a
                className="font-mono text-accent underline underline-offset-2 hover:text-accent-ink"
                href={`#/chat/${encodeURIComponent(sessionId)}`}
              >
                {sessionId}
              </a>
            ) : (
              <span className="font-mono">—</span>
            ),
          },
          {
            key: 'started',
            label: t('runs.detail.started'),
            value: <span className="font-mono tabular-nums">{formatTimestamp(startedAt)}</span>,
          },
          {
            key: 'ended',
            label: t('runs.detail.ended'),
            value: <span className="font-mono tabular-nums">{formatTimestamp(completedAt)}</span>,
          },
          {
            key: 'duration',
            label: t('runs.detail.duration'),
            value: (
              <span className="font-mono tabular-nums">
                {durationLabel(startedAt, completedAt)}
              </span>
            ),
          },
          ...(run?.iteration !== undefined || durable?.iteration !== undefined
            ? [
                {
                  key: 'iteration',
                  label: 'Iteration',
                  value: (
                    <span className="font-mono tabular-nums">
                      {run?.iteration ?? durable?.iteration}
                    </span>
                  ),
                },
              ]
            : []),
          ...(run?.agent_id || durable?.agent_id
            ? [
                {
                  key: 'agent',
                  label: 'Agent',
                  value: <span className="font-mono">{run?.agent_id ?? durable?.agent_id}</span>,
                },
              ]
            : []),
          ...(usage
            ? [
                {
                  key: 'tokens',
                  label: 'Tokens',
                  value: (
                    <span className="font-mono tabular-nums">
                      {usage.prompt_tokens ?? 0} + {usage.completion_tokens ?? 0} ={' '}
                      {usage.total_tokens ?? 0}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      <div className="mt-2.5 flex flex-wrap gap-2">
        {cancellable && (
          <Button
            size="small"
            variant="dangerGhost"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onCancel(runId)}
          >
            {busy ? t('runs.detail.cancelling') : t('runs.detail.cancel')}
          </Button>
        )}
        {resumable && (
          <Button
            size="small"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onResume(runId)}
          >
            {busy ? t('runs.detail.resuming') : t('runs.detail.resume')}
          </Button>
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
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <fieldset className="flex flex-wrap gap-1">
              <legend className="sr-only">{t('runs.detail.filtersLabel')}</legend>
              {RUN_EVENT_FILTERS.map((item) => (
                <Button
                  key={item.id}
                  variant="chip"
                  size="small"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {t(item.labelKey)}
                </Button>
              ))}
            </fieldset>
            <Input
              className="w-auto max-w-56 px-2.25 py-1.25 text-xs font-mono"
              value={typePrefix}
              onChange={(event) => setTypePrefix(event.target.value)}
              placeholder={t('runs.detail.typePrefix')}
              aria-label={t('runs.detail.typePrefixLabel')}
              spellCheck={false}
            />
            <Button
              size="small"
              className="aria-pressed:bg-accent-soft aria-pressed:text-accent-ink"
              aria-pressed={showInternal}
              onClick={() => setShowInternal((value) => !value)}
            >
              {t('runs.detail.showInternal')}
            </Button>
            <Button size="small" onClick={() => void loadFirstPage()}>
              {t('runs.detail.refreshEvents')}
            </Button>
            <Badge>
              {filtered.length}/{events.length}
            </Badge>
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
                <div className="mt-2 flex max-h-105 flex-col gap-1 overflow-y-auto rounded-md bg-sunken px-2.5 py-1.5">
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
                <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm">
                  <Button
                    size="small"
                    disabled={loadingMore || sinceSeq === undefined}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore
                      ? t('runs.detail.loadingMore')
                      : t('runs.detail.loadMore', { count: trace.length })}
                  </Button>
                  {sinceSeq === undefined && (
                    <span className="text-muted">{t('runs.detail.missingSeq')}</span>
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
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.errorTitle')}</h3>
              <pre className="run-output text-danger">{run.error}</pre>
            </>
          )}
          {run?.output ? (
            <>
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.outputTitle')}</h3>
              <pre className="run-output">{run.output}</pre>
            </>
          ) : durable?.preview ? (
            <>
              <h3 className="text-md font-semibold text-ink">
                {t('runs.detail.checkpointPreview')}
              </h3>
              <pre className="run-output">{durable.preview}</pre>
            </>
          ) : lastCheckpointMessage ? (
            <>
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.checkpoint')}</h3>
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
              <div className="mt-3.5 flex flex-wrap gap-2">
                <CopyButton
                  text={pretty(raw)}
                  label={t('runs.detail.copyJson')}
                  toast={t('runs.detail.copiedJson')}
                />
                <Button size="small" onClick={() => exportJson(raw, runId)}>
                  {t('runs.detail.exportJson')}
                </Button>
              </div>
              <JsonView value={raw} label={t('runs.detail.rawJsonLabel')} open maxHeight={520} />
            </>
          ) : (
            <LoadingState label={t('runs.detailLoading')} />
          )}
        </div>
      )}
    </Section>
  );
}
