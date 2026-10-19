import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { CopyButton } from '../../components/CopyButton';
import { PageHeader } from '../../components/PageHeader';
import { usePaletteEntities } from '../../components/PaletteEntities';
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
import { useConnection } from '../../gateway/ConnectionProvider';
import type { DurableRunSummary, RunEvent, RunStatus } from '../../gateway/types';
import {
  filterDurableRuns,
  filterLiveRuns,
  isAlreadyResumedError,
  isCancellableRun,
  isResumableRun,
  type RunStatusFilter,
  sortDurableRuns,
  sortLiveRuns,
  takeRuns,
} from '../../state/runs';
import { type ResourceState, resourceData, useResource } from '../../state/useResource';
import { EventRow } from '../chat/EventRow';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

interface RunDetailData {
  run: RunStatus | null;
  durable: DurableRunSummary | null;
  events: RunEvent[];
  eventsError: string | null;
}

const LIVE_FILTERS: readonly { id: RunStatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'queued', label: '排队' },
  { id: 'running', label: '运行中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
];

const DURABLE_FILTERS: readonly { id: RunStatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'interrupted', label: '已中断' },
  { id: 'running', label: '运行中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationLabel(start?: number, end?: number): string {
  if (start === undefined) return '—';
  const value = Math.max(0, (end ?? Date.now()) - start);
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function RunsView({
  route,
  navigate,
}: {
  route: RunsRoute;
  navigate: (route: Route) => void;
}) {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const durableAvailable = connected && features.includes('durable-resume');

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<RunStatusFilter>('all');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const liveResource = useResource({
    load: () => client.listRuns(),
    enabled: connected,
    pollMs: 10_000,
    deps: [epoch],
  });
  const durableResource = useResource({
    load: () => client.listDurableRuns({ limit: 200 }),
    enabled: durableAvailable,
    pollMs: 15_000,
    deps: [epoch],
  });

  const live = sortLiveRuns(resourceData(liveResource.state) ?? []);
  const durable = sortDurableRuns(resourceData(durableResource.state) ?? []);
  const filteredLive = filterLiveRuns(live, {
    query,
    status,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
  });
  const filteredDurable = filterDurableRuns(durable, {
    query,
    status,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
  });
  const windowedLive = takeRuns(filteredLive, limit);
  const windowedDurable = takeRuns(filteredDurable, limit);

  // 切换 tab / 过滤时回到第一页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值变化时重置窗口
  useEffect(() => {
    setLimit(100);
    setStatus('all');
  }, [route.tab]);

  const knownLive = route.runId ? live.find((run) => run.run_id === route.runId) : undefined;
  const knownDurable = route.runId ? durable.find((run) => run.run_id === route.runId) : undefined;
  const activeDetail = Boolean(
    route.runId && (knownLive?.status === 'queued' || knownLive?.status === 'running'),
  );

  const detailResource = useResource({
    load: async () => {
      if (!route.runId) return null;
      let run: RunStatus | null = knownLive ?? null;
      // Live 深链即使不在当前列表窗口内也能取到摘要；durable checkpoint 不走 runs.get。
      if (route.tab === 'live') {
        try {
          run = await client.getRunCanonical(route.runId);
        } catch {
          run = knownLive ?? null;
        }
      }
      let events: RunEvent[] = [];
      let eventsError: string | null = null;
      try {
        events = await client.readEvents({ run_id: route.runId, limit: 200 });
      } catch (error) {
        eventsError = errorMessage(error);
      }
      return {
        run,
        durable: knownDurable ?? null,
        events,
        eventsError,
      };
    },
    enabled: connected && Boolean(route.runId),
    ...(activeDetail ? { pollMs: 2000 } : {}),
    deps: [route.runId, epoch],
  });

  const reloadAll = useCallback(() => {
    liveResource.reload();
    durableResource.reload();
    detailResource.reload();
  }, [liveResource.reload, durableResource.reload, detailResource.reload]);
  useRefreshSignal(reloadAll);

  // 命令面板实体：最近 live/durable run，可直接打开详情。
  const paletteEntities = useMemo(() => {
    const liveRuns = sortLiveRuns(resourceData(liveResource.state) ?? []).slice(0, 10);
    const durableRuns = sortDurableRuns(resourceData(durableResource.state) ?? []).slice(0, 10);
    return [
      ...liveRuns.map((run) => ({
        id: `run-${run.run_id}`,
        group: 'entity' as const,
        label: `运行 ${run.run_id.slice(0, 14)}`,
        keywords: [run.session_id, run.status],
        hint: '运行',
        run: () =>
          navigate({ domain: 'runs', tab: 'live', runId: run.run_id, sessionId: run.session_id }),
      })),
      ...durableRuns.map((run) => ({
        id: `durable-${run.run_id}`,
        group: 'entity' as const,
        label: `可恢复 ${run.run_id.slice(0, 14)}`,
        keywords: [run.session_id, run.status, run.agent_id ?? ''],
        hint: '运行',
        run: () =>
          navigate({
            domain: 'runs',
            tab: 'durable',
            runId: run.run_id,
            sessionId: run.session_id,
          }),
      })),
    ];
  }, [liveResource.state, durableResource.state, navigate]);
  usePaletteEntities('runs', paletteEntities);

  const withBusy = async (runId: string, action: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(runId));
    try {
      await action();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  const cancel = (runId: string) =>
    void withBusy(runId, async () => {
      try {
        const result = await client.cancelRun(runId);
        if (result.cancelled) {
          toast.success('已请求取消 run');
          liveResource.reload();
        } else {
          toast.error('取消请求未被受理，run 可能已开始执行');
        }
      } catch (error) {
        toast.error(errorMessage(error));
      }
    });

  const resume = (runId: string) =>
    void withBusy(runId, async () => {
      try {
        await client.resumeRun(runId);
        toast.success('已排队恢复运行');
        durableResource.reload();
      } catch (error) {
        if (isAlreadyResumedError(error)) {
          toast.info('该运行已在恢复中');
          durableResource.reload();
        } else {
          toast.error(errorMessage(error));
        }
      }
    });

  const navigateRoute = (patch: Partial<RunsRoute>) => {
    const next: RunsRoute = { ...route, ...patch };
    navigate(next);
  };

  const filterList = route.tab === 'live' ? LIVE_FILTERS : DURABLE_FILTERS;
  const loading =
    route.tab === 'live'
      ? liveResource.state.status === 'idle' ||
        (liveResource.state.status === 'loading' && live.length === 0)
      : durableResource.state.status === 'idle' ||
        (durableResource.state.status === 'loading' && durable.length === 0);
  const error =
    route.tab === 'live'
      ? liveResource.state.status === 'error'
        ? liveResource.state.error
        : null
      : durableResource.state.status === 'error'
        ? durableResource.state.error
        : null;

  return (
    <div className="domain-view">
      <PageHeader
        title="运行"
        description="Live 是当前 gateway 进程内的执行；可恢复来自持久 checkpoint。"
        tenantId={tenantId}
      />
      <SegmentedTabs
        label="运行来源"
        tabs={[
          { id: 'live', label: 'Live（进程内）' },
          { id: 'durable', label: '可恢复' },
        ]}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'runs', tab })}
      />

      <div className="filter-bar">
        <input
          className="input search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 run id / session / 输出 / 错误"
          type="search"
          aria-label="搜索运行"
        />
        <fieldset className="filter-chips">
          <legend className="sr-only">按状态过滤运行</legend>
          {filterList.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`filter-chip ${filter.id === status ? 'active' : ''}`.trim()}
              aria-pressed={filter.id === status}
              onClick={() => setStatus(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </fieldset>
        {route.sessionId && (
          <button
            type="button"
            className="filter-chip active"
            onClick={() => navigateRoute({ sessionId: undefined, runId: undefined })}
            title="清除会话过滤"
          >
            会话 {route.sessionId.slice(0, 12)} ×
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={reloadAll} disabled={!connected}>
          刷新
        </button>
      </div>

      <div className="domain-content">
        {route.tab === 'durable' && !durableAvailable ? (
          <NotEnabledState
            title="可恢复运行未启用"
            reason="此 gateway 没有 durable store / resume。"
            hint="需要启用 durable.store 与 durable.resume 后重启 gateway。"
          />
        ) : !connected ? (
          <EmptyState
            title="连接 gateway 后显示运行。"
            action={
              <button
                type="button"
                className="btn"
                onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
              >
                配置连接
              </button>
            }
          />
        ) : error && (route.tab === 'live' ? live.length === 0 : durable.length === 0) ? (
          <ErrorState
            message={error}
            onRetry={route.tab === 'live' ? liveResource.reload : durableResource.reload}
          />
        ) : loading ? (
          <LoadingState label="正在加载运行…" />
        ) : route.tab === 'live' ? (
          live.length === 0 ? (
            <EmptyState title="当前 gateway 进程还没有运行记录。" />
          ) : filteredLive.length === 0 ? (
            <EmptyState title="没有匹配的运行。" description="清除搜索或状态过滤后重试。" />
          ) : (
            <>
              {liveResource.state.status === 'error' && (
                <StaleNotice
                  message={`更新失败，显示旧数据：${liveResource.state.error}`}
                  onRetry={liveResource.reload}
                />
              )}
              <table className="data-table runs-table">
                <thead>
                  <tr>
                    <th scope="col">状态</th>
                    <th scope="col">运行 ID</th>
                    <th scope="col" className="col-session">
                      会话
                    </th>
                    <th scope="col">开始</th>
                    <th scope="col" className="col-meta">
                      耗时
                    </th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {windowedLive.shown.map((run) => (
                    <tr
                      key={run.run_id}
                      className={run.run_id === route.runId ? 'row-active' : undefined}
                    >
                      <td>
                        <StatusChip status={run.status} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-btn mono"
                          onClick={() => navigateRoute({ runId: run.run_id })}
                        >
                          {run.run_id.slice(0, 14)}
                        </button>
                      </td>
                      <td className="col-session mono">
                        <button
                          type="button"
                          className="link-btn mono"
                          onClick={() => navigate({ domain: 'chat', sessionId: run.session_id })}
                        >
                          {run.session_id.slice(0, 12)}
                        </button>
                      </td>
                      <td className="mono">{formatTimestamp(run.started_at)}</td>
                      <td className="mono col-meta">
                        {durationLabel(run.started_at, run.completed_at)}
                      </td>
                      <td>
                        {isCancellableRun(run.status) ? (
                          <button
                            type="button"
                            className="btn btn-small btn-danger-ghost"
                            disabled={busy.has(run.run_id)}
                            onClick={() => cancel(run.run_id)}
                          >
                            {busy.has(run.run_id) ? '取消中…' : '取消'}
                          </button>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {windowedLive.hiddenCount > 0 && (
                <button
                  type="button"
                  className="load-more"
                  onClick={() => setLimit((value) => value + 100)}
                >
                  显示更多（还有 {windowedLive.hiddenCount} 条）
                </button>
              )}
            </>
          )
        ) : durable.length === 0 ? (
          <EmptyState title="没有匹配的可恢复运行。" description="清除过滤后重试。" />
        ) : filteredDurable.length === 0 ? (
          <EmptyState title="没有匹配的可恢复运行。" description="清除过滤后重试。" />
        ) : (
          <>
            {durableResource.state.status === 'error' && (
              <StaleNotice
                message={`更新失败，显示旧数据：${durableResource.state.error}`}
                onRetry={durableResource.reload}
              />
            )}
            <table className="data-table runs-table">
              <thead>
                <tr>
                  <th scope="col">状态</th>
                  <th scope="col">运行 ID</th>
                  <th scope="col" className="col-session">
                    会话
                  </th>
                  <th scope="col" className="col-meta">
                    Agent
                  </th>
                  <th scope="col">更新</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {windowedDurable.shown.map((run) => (
                  <tr
                    key={run.run_id}
                    className={run.run_id === route.runId ? 'row-active' : undefined}
                  >
                    <td>
                      <StatusChip status={run.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-btn mono"
                        onClick={() => navigateRoute({ runId: run.run_id })}
                      >
                        {run.run_id.slice(0, 14)}
                      </button>
                    </td>
                    <td className="col-session mono">
                      <button
                        type="button"
                        className="link-btn mono"
                        onClick={() => navigate({ domain: 'chat', sessionId: run.session_id })}
                      >
                        {run.session_id.slice(0, 12)}
                      </button>
                    </td>
                    <td className="mono col-meta">{run.agent_id ?? '—'}</td>
                    <td className="mono">{formatTimestamp(run.updated_at)}</td>
                    <td>
                      {isResumableRun(run.status) ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy.has(run.run_id)}
                          onClick={() => resume(run.run_id)}
                        >
                          {busy.has(run.run_id) ? '恢复中…' : '恢复运行'}
                        </button>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {windowedDurable.hiddenCount > 0 && (
              <button
                type="button"
                className="load-more"
                onClick={() => setLimit((value) => value + 100)}
              >
                显示更多（还有 {windowedDurable.hiddenCount} 条）
              </button>
            )}
          </>
        )}

        {route.runId && <RunDetailPanel resource={detailResource.state} />}
      </div>
    </div>
  );
}

function RunDetailPanel({ resource }: { resource: ResourceState<RunDetailData | null> }) {
  const data = resourceData(resource);
  if (resource.status === 'idle' || (resource.status === 'loading' && !data)) {
    return <LoadingState label="正在加载运行详情…" />;
  }
  if (!data) {
    return <ErrorState message={resource.status === 'error' ? resource.error : '运行不存在'} />;
  }
  const run = data.run;
  const durable = data.durable;
  return (
    <section className="panel run-detail" aria-label="运行详情">
      <div className="panel-header">
        <h2 className="section-title">运行详情</h2>
        <span className="mono dim">{run?.run_id ?? durable?.run_id}</span>
        <CopyButton
          text={run?.run_id ?? durable?.run_id ?? ''}
          label="复制运行 ID"
          toast="已复制运行 ID"
        />
      </div>
      <dl className="diag-list">
        <dt>状态</dt>
        <dd>
          <StatusChip status={run?.status ?? durable?.status} />
        </dd>
        <dt>会话</dt>
        <dd className="mono">{run?.session_id ?? durable?.session_id ?? '—'}</dd>
        {durable && (
          <>
            <dt>Agent</dt>
            <dd className="mono">{durable.agent_id ?? '—'}</dd>
            <dt>Iteration</dt>
            <dd className="mono">{durable.iteration ?? '—'}</dd>
          </>
        )}
        <dt>开始</dt>
        <dd className="mono">{formatTimestamp(run?.started_at)}</dd>
        <dt>结束</dt>
        <dd className="mono">{formatTimestamp(run?.completed_at)}</dd>
        <dt>耗时</dt>
        <dd className="mono">{durationLabel(run?.started_at, run?.completed_at)}</dd>
      </dl>
      {run?.output && (
        <>
          <h3 className="section-title">输出</h3>
          <pre className="run-output">{run.output}</pre>
        </>
      )}
      {run?.error && (
        <>
          <h3 className="section-title">错误</h3>
          <pre className="run-output err">{run.error}</pre>
        </>
      )}
      {durable?.preview && <p className="section-desc">{durable.preview}</p>}

      <h3 className="section-title">事件记录</h3>
      {data.eventsError ? (
        <NotEnabledState
          title="事件回放不可用（trace 未启用或无记录）。"
          reason={data.eventsError}
        />
      ) : data.events.length === 0 ? (
        <p className="section-desc">没有事件记录。</p>
      ) : (
        <div className="event-list">
          {data.events.map((event, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: trace 事件按顺序展示
            <EventRow key={`${event.ts}-${index}`} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}
