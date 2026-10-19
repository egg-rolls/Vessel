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
import {
  filterRunEvents,
  groupRunEvents,
  isTraceUnavailable,
  mergeRunEvents,
  nextSinceSeq,
  RUN_EVENT_FILTERS,
  type RunEventFilter,
  type ToolCallGroup,
} from '../../state/run-detail';
import { isCancellableRun, isResumableRun } from '../../state/runs';
import { EventRow } from '../chat/EventRow';

const EVENT_PAGE_SIZE = 500;

type DetailTab = 'timeline' | 'output' | 'raw';

const DETAIL_TABS: readonly { id: DetailTab; label: string }[] = [
  { id: 'timeline', label: '时间线' },
  { id: 'output', label: '输出' },
  { id: 'raw', label: 'Raw JSON' },
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
    group.status === 'failed' ? '失败' : group.status === 'completed' ? '完成' : '调用中';
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
            <p className="section-desc">没有可展开的参数或结果。</p>
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

  // 实时事件的 run_id 是 core run id；live 列表的 run_id 是 gateway 引擎 id。
  const coreRunId =
    tab === 'durable' ? (run?.run_id ?? durable?.run_id ?? runId) : (run?.core_run_id ?? undefined);

  const liveEvents = useMemo(() => {
    if (!coreRunId) return [];
    return snapshot.entries
      .filter((entry) => entry.event.run_id === coreRunId)
      .map((entry) => entry.event);
  }, [snapshot.entries, coreRunId]);

  const loadFirstPage = useCallback(async () => {
    if (!coreRunId || !hasToken) return;
    setTraceLoading(true);
    setTraceError(null);
    try {
      const events = await client.readEvents({ run_id: coreRunId, limit: EVENT_PAGE_SIZE });
      setTrace(events);
      setHasMore(events.length >= EVENT_PAGE_SIZE);
    } catch (error) {
      setTrace([]);
      setHasMore(false);
      setTraceError({
        code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTraceLoading(false);
    }
  }, [client, coreRunId, hasToken]);

  // 切换 run / 手动重载：重置过滤器与分页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId/coreRunId 变化时重置
  useEffect(() => {
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

  const events = useMemo(() => mergeRunEvents(trace, liveEvents), [trace, liveEvents]);
  const filtered = useMemo(
    () => filterRunEvents(events, { filter, showInternal, typePrefix }),
    [events, filter, showInternal, typePrefix],
  );
  const items = useMemo(() => groupRunEvents(filtered), [filtered]);
  const sinceSeq = nextSinceSeq(trace);

  const loadMore = async () => {
    if (!coreRunId || sinceSeq === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.readEvents({
        run_id: coreRunId,
        since_seq: sinceSeq,
        limit: EVENT_PAGE_SIZE,
      });
      setTrace((prev) => mergeRunEvents(prev, next));
      setHasMore(next.length >= EVENT_PAGE_SIZE);
    } catch (error) {
      toast.error(`加载更多事件失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const status = run?.status ?? durable?.status;
  const sessionId = run?.session_id ?? durable?.session_id;
  const startedAt = run?.started_at;
  const completedAt = run?.completed_at;
  const usage = run?.usage;
  const raw = run ?? durable;
  const cancellable = tab === 'live' && status !== undefined && isCancellableRun(status);
  const resumable = tab === 'durable' && status !== undefined && isResumableRun(status);

  return (
    <section className="panel run-detail" aria-label="运行详情">
      <div className="panel-header">
        <h2 className="section-title">运行详情</h2>
        <StatusChip status={status} />
        <span className="mono dim run-detail-id" title={runId}>
          {runId}
        </span>
        <CopyButton text={runId} label="复制运行 ID" toast="已复制运行 ID" />
        <button type="button" className="btn btn-small" onClick={() => exportJson(raw, runId)}>
          导出 JSON
        </button>
        <button type="button" className="icon-btn" aria-label="关闭运行详情" onClick={onClose}>
          ×
        </button>
      </div>

      <dl className="diag-list">
        <dt>会话</dt>
        <dd className="mono">
          {sessionId ? (
            <a className="link-btn mono" href={`#/chat/${encodeURIComponent(sessionId)}`}>
              {sessionId}
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>开始</dt>
        <dd className="mono">{formatTimestamp(startedAt)}</dd>
        <dt>结束</dt>
        <dd className="mono">{formatTimestamp(completedAt)}</dd>
        <dt>耗时</dt>
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
            title={!canWrite ? '连接断开，写操作已禁用' : undefined}
            onClick={() => onCancel(runId)}
          >
            {busy ? '取消中…' : '取消 run'}
          </button>
        )}
        {resumable && (
          <button
            type="button"
            className="btn btn-small"
            disabled={!canWrite || busy}
            title={!canWrite ? '连接断开，写操作已禁用' : undefined}
            onClick={() => onResume(runId)}
          >
            {busy ? '恢复中…' : '恢复运行'}
          </button>
        )}
      </div>

      {!connected && (
        <StaleNotice message="连接已断开；以下数据为最近一次读取的结果。" onRetry={loadFirstPage} />
      )}

      <SegmentedTabs label="运行详情视图" tabs={DETAIL_TABS} value={view} onChange={setView} />

      {view === 'timeline' && (
        <div role="tabpanel" aria-label="事件时间线">
          <div className="filter-bar">
            <fieldset className="filter-chips">
              <legend className="sr-only">按事件类别过滤</legend>
              {RUN_EVENT_FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`filter-chip ${filter === item.id ? 'active' : ''}`.trim()}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </fieldset>
            <input
              className="input input-compact mono"
              value={typePrefix}
              onChange={(event) => setTypePrefix(event.target.value)}
              placeholder="类型前缀，如 tool.call."
              aria-label="按事件类型前缀过滤"
              spellCheck={false}
            />
            <button
              type="button"
              className={`btn btn-small ${showInternal ? 'active' : ''}`.trim()}
              aria-pressed={showInternal}
              onClick={() => setShowInternal((value) => !value)}
            >
              内部事件
            </button>
            <button type="button" className="btn btn-small" onClick={() => void loadFirstPage()}>
              刷新事件
            </button>
            <span className="count-pill">
              {filtered.length}/{events.length}
            </span>
          </div>

          {traceError && events.length === 0 ? (
            isTraceUnavailable(traceError) ? (
              <NotEnabledState
                title="事件回放不可用（trace 未启用或无记录）。"
                reason={traceError.message}
                hint="run 摘要与输出仍可用；启用 trace 后重启 gateway 可查看完整时间线。"
              />
            ) : (
              <ErrorState message={traceError.message} onRetry={() => void loadFirstPage()} />
            )
          ) : (
            <>
              {traceError && (
                <StaleNotice
                  message={`trace 回放不可用；仅显示实时缓冲中的 ${liveEvents.length} 条事件。`}
                  onRetry={() => void loadFirstPage()}
                />
              )}
              {traceLoading && events.length === 0 ? (
                <LoadingState label="正在读取事件记录…" />
              ) : events.length === 0 ? (
                <EmptyState
                  title="没有事件记录。"
                  description={
                    tab === 'live' && !coreRunId
                      ? '该运行尚未映射到 core run（可能仍在排队），暂时没有 trace。'
                      : 'trace 中没有该 run 的事件；输出与 Raw JSON 仍可查看。'
                  }
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  title="没有匹配的事件。"
                  description="调整类别、内部事件开关或类型前缀。"
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
                    {loadingMore ? '加载中…' : `加载更多事件（已显示 ${trace.length} 条）`}
                  </button>
                  {sinceSeq === undefined && (
                    <span className="dim">事件缺少 seq，无法继续分页；可刷新重新读取。</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === 'output' && (
        <div role="tabpanel" aria-label="运行输出">
          {run?.error && (
            <>
              <h3 className="section-title">错误</h3>
              <pre className="run-output err">{run.error}</pre>
            </>
          )}
          {run?.output ? (
            <>
              <h3 className="section-title">输出</h3>
              <pre className="run-output">{run.output}</pre>
            </>
          ) : durable?.preview ? (
            <>
              <h3 className="section-title">最后一条消息（checkpoint 预览）</h3>
              <pre className="run-output">{durable.preview}</pre>
            </>
          ) : (
            <EmptyState title="没有可显示的输出。" description="运行可能仍在进行或已取消。" />
          )}
        </div>
      )}

      {view === 'raw' && (
        <div role="tabpanel" aria-label="原始 JSON">
          {raw ? (
            <>
              <div className="form-actions">
                <CopyButton
                  text={pretty(raw)}
                  label="复制 JSON"
                  toast="已复制运行 JSON"
                  className="btn btn-small"
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => exportJson(raw, runId)}
                >
                  导出 JSON
                </button>
              </div>
              <JsonView value={raw} label="Run JSON（原始字段）" open maxHeight={520} />
            </>
          ) : (
            <LoadingState label="正在读取运行详情…" />
          )}
        </div>
      )}
    </section>
  );
}
