import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
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
import type { DurableRunSummary, RunStatus } from '../../gateway/types';
import { buildRunPaletteActions } from '../../state/palette-actions';
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
import { resourceData, useResource } from '../../state/useResource';
import { RunDetail } from './RunDetail';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

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
  const { client, connectionState, hasToken, features, epoch, tenantId, eventStore } =
    useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const durableAvailable = hasToken && features.includes('durable-resume');

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<RunStatusFilter>('all');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const liveResource = useResource({
    load: () => client.listRuns(),
    enabled: hasToken,
    pollMs: 10_000,
    deps: [epoch],
  });
  const durableResource = useResource({
    load: () => client.listDurableRuns({ limit: 200 }),
    enabled: durableAvailable,
    pollMs: 15_000,
    deps: [epoch],
  });

  const live = useMemo(
    () => sortLiveRuns(resourceData(liveResource.state) ?? []),
    [liveResource.state],
  );
  const durable = useMemo(
    () => sortDurableRuns(resourceData(durableResource.state) ?? []),
    [durableResource.state],
  );
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

  // 切换 tab 时回到第一页与「全部」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: route.tab 变化是重置条件
  useEffect(() => {
    setLimit(100);
    setStatus('all');
  }, [route.tab]);

  const knownLive = route.runId ? live.find((run) => run.run_id === route.runId) : undefined;
  const knownDurable = route.runId ? durable.find((run) => run.run_id === route.runId) : undefined;

  // 活动 run 的 2s 轮询由 useResource 管理（页面隐藏时暂停）；终态自动停止。
  const [detailPolling, setDetailPolling] = useState(false);
  const detailResource = useResource({
    load: async () => {
      if (!route.runId) return null;
      try {
        // runs.get 对 live 返回引擎 run，对 durable 回退 checkpoint。
        return await client.getRunCanonical(route.runId);
      } catch {
        // durable 只存在于 list 中（例如 gateway 未注入 store 的瞬时状态）时保留摘要。
        return route.tab === 'live' ? (knownLive ?? null) : null;
      }
    },
    enabled: hasToken && Boolean(route.runId),
    ...(connected && detailPolling ? { pollMs: 2000 } : {}),
    deps: [route.runId, route.tab, epoch],
  });
  // useResource 刷新时会保留旧数据；路由切到另一个 run 时必须丢弃旧 id 的响应。
  const fetchedDetail = resourceData(detailResource.state);
  const detailRun =
    fetchedDetail && fetchedDetail.run_id === route.runId ? fetchedDetail : (knownLive ?? null);
  const detailStatus = detailRun?.status ?? knownDurable?.status;
  const activeDetail = detailStatus === 'queued' || detailStatus === 'running';

  // biome-ignore lint/correctness/useExhaustiveDependencies: route 变化时必须重置轮询
  useEffect(() => {
    setDetailPolling(false);
  }, [route.runId, route.tab]);
  useEffect(() => {
    if (detailRun) setDetailPolling(detailStatus === 'queued' || detailStatus === 'running');
  }, [detailRun, detailStatus]);

  const reloadAll = useCallback(() => {
    liveResource.reload();
    durableResource.reload();
    detailResource.reload();
  }, [liveResource.reload, durableResource.reload, detailResource.reload]);
  useRefreshSignal(reloadAll);

  // 事件驱动刷新：run.* 事件后 500ms 合并刷新（10s 轮询兜底，页面隐藏时暂停）。
  // 直接订阅 store，避免每个流式合批都重渲染整个列表。
  const lastVersion = useRef(-1);
  const eventTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = eventStore.subscribe(() => {
      const snapshot = eventStore.getSnapshot();
      if (snapshot.version === lastVersion.current) return;
      lastVersion.current = snapshot.version;
      const recent = snapshot.entries.slice(-100);
      if (!recent.some(({ event }) => event.type.startsWith('run.'))) return;
      window.clearTimeout(eventTimer.current);
      eventTimer.current = window.setTimeout(() => {
        liveResource.reload();
        if (durableAvailable) durableResource.reload();
        if (route.runId) detailResource.reload();
      }, 500);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(eventTimer.current);
    };
  }, [
    eventStore,
    liveResource.reload,
    durableResource.reload,
    detailResource.reload,
    durableAvailable,
    route.runId,
  ]);

  const withBusy = useCallback(async (runId: string, action: () => Promise<void>) => {
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
  }, []);

  const cancel = useCallback(
    (runId: string) => {
      if (!connected) {
        toast.error('连接断开，无法取消运行');
        return;
      }
      void withBusy(runId, async () => {
        try {
          const result = await client.cancelRun(runId);
          if (result.cancelled) {
            toast.success('已请求取消 run');
            liveResource.reload();
            if (route.runId === runId) detailResource.reload();
          } else {
            toast.error('取消请求未被受理，run 可能已开始执行');
          }
        } catch (error) {
          toast.error(errorMessage(error));
        }
      });
    },
    [client, connected, detailResource.reload, liveResource.reload, route.runId, toast, withBusy],
  );

  const resume = useCallback(
    (runId: string) => {
      if (!connected) {
        toast.error('连接断开，无法恢复运行');
        return;
      }
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
    },
    [client, connected, durableResource.reload, toast, withBusy],
  );

  // 命令面板：最近 run 的实体 + 取消/恢复/打开动作。
  const paletteEntities = useMemo(() => {
    const liveRuns = live.slice(0, 10);
    const durableRuns = durable.slice(0, 10);
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
  }, [live, durable, navigate]);
  const paletteActions = useMemo(
    () =>
      buildRunPaletteActions({
        live,
        durable,
        openRun: (runId, tab, sessionId) => navigate({ domain: 'runs', tab, runId, sessionId }),
        cancel,
        resume,
      }),
    [live, durable, navigate, cancel, resume],
  );
  usePaletteEntities('runs', [...paletteEntities, ...paletteActions]);

  const navigateRoute = (patch: Partial<RunsRoute>) => {
    navigate({ ...route, ...patch });
  };

  const filterList = route.tab === 'live' ? LIVE_FILTERS : DURABLE_FILTERS;
  const current = route.tab === 'live' ? live : durable;
  const filtered = route.tab === 'live' ? filteredLive : filteredDurable;
  const windowed = route.tab === 'live' ? windowedLive : windowedDurable;
  const resource = route.tab === 'live' ? liveResource : durableResource;
  const resourceError = resource.state.status === 'error' ? resource.state.error : null;
  const loading =
    resource.state.status === 'idle' ||
    (resource.state.status === 'loading' && current.length === 0);
  const detailMissing =
    Boolean(route.runId) &&
    !detailRun &&
    !knownDurable &&
    detailResource.state.status !== 'idle' &&
    detailResource.state.status !== 'loading';
  const detailLoading =
    Boolean(route.runId) &&
    (detailResource.state.status === 'idle' || detailResource.state.status === 'loading') &&
    !detailRun &&
    !knownDurable;

  return (
    <div className={`domain-view ${route.runId ? 'detail-open' : ''}`.trim()}>
      <PageHeader
        title="运行"
        description="Live 是当前 gateway 进程内的执行（内存，最多约 200 条）；可恢复来自持久 checkpoint。"
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
        panelId="runs-panel"
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
        <button type="button" className="btn btn-small" onClick={reloadAll} disabled={!hasToken}>
          刷新
        </button>
      </div>

      <div className="domain-content" id="runs-panel" role="tabpanel" aria-label="运行内容">
        {!hasToken ? (
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
        ) : route.tab === 'durable' && !durableAvailable ? (
          <NotEnabledState
            title="可恢复运行未启用"
            reason="此 gateway 没有启用持久运行恢复。"
            hint="需要启用 checkpoint 存储与 resume 后重启 gateway。"
          />
        ) : (
          <>
            {!connected && current.length > 0 && (
              <StaleNotice
                message="连接已断开；显示最近一次读取的运行列表，写操作已禁用。"
                onRetry={reloadAll}
              />
            )}
            {resourceError && current.length > 0 && (
              <StaleNotice message={`更新失败，显示旧数据：${resourceError}`} onRetry={reloadAll} />
            )}

            {resourceError && current.length === 0 ? (
              <ErrorState message={resourceError} onRetry={resource.reload} />
            ) : loading ? (
              <LoadingState label="正在加载运行…" />
            ) : current.length === 0 ? (
              <EmptyState
                title={
                  route.tab === 'live'
                    ? '当前 gateway 进程还没有运行记录。'
                    : '没有匹配的可恢复运行。'
                }
                description={
                  route.tab === 'live'
                    ? '在会话中发送一条 prompt 后，运行会出现在这里。'
                    : '调整状态过滤或清除会话过滤后重试。'
                }
                action={
                  route.tab === 'live' ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => navigate({ domain: 'chat', sessionId: 'new' })}
                    >
                      新建会话
                    </button>
                  ) : undefined
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="没有匹配的运行。"
                description="清除搜索、状态或会话过滤后重试。"
                action={
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setQuery('');
                      setStatus('all');
                      navigateRoute({ sessionId: undefined });
                    }}
                  >
                    清除过滤
                  </button>
                }
              />
            ) : route.tab === 'live' ? (
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
                    <th scope="col" className="col-optional">
                      Tokens
                    </th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {windowed.shown.map((raw) => {
                    const run = raw as RunStatus;
                    return (
                      <tr
                        key={run.run_id}
                        className={run.run_id === route.runId ? 'row-active' : undefined}
                      >
                        <td>
                          <StatusChip
                            status={run.status}
                            label={
                              run.status === 'queued' && run.queue_position !== undefined
                                ? `排队 · 第 ${run.queue_position} 位`
                                : undefined
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link-btn mono"
                            onClick={() =>
                              navigateRoute({ runId: run.run_id, sessionId: run.session_id })
                            }
                          >
                            {run.run_id.slice(0, 16)}
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
                        <td className="mono col-optional">{run.usage?.total_tokens ?? '—'}</td>
                        <td>
                          {isCancellableRun(run.status) ? (
                            <button
                              type="button"
                              className="btn btn-small btn-danger-ghost"
                              disabled={!connected || busy.has(run.run_id)}
                              title={!connected ? '连接断开，写操作已禁用' : undefined}
                              onClick={() => cancel(run.run_id)}
                            >
                              {busy.has(run.run_id) ? '取消中…' : '取消'}
                            </button>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="data-table runs-table">
                <thead>
                  <tr>
                    <th scope="col">状态</th>
                    <th scope="col">运行 ID</th>
                    <th scope="col" className="col-session">
                      会话
                    </th>
                    <th scope="col" className="col-optional">
                      Agent
                    </th>
                    <th scope="col" className="col-meta">
                      Iter
                    </th>
                    <th scope="col">更新</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {windowed.shown.map((raw) => {
                    const run = raw as DurableRunSummary;
                    return (
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
                            onClick={() =>
                              navigateRoute({ runId: run.run_id, sessionId: run.session_id })
                            }
                          >
                            {run.run_id.slice(0, 16)}
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
                        <td className="mono col-optional">{run.agent_id ?? '—'}</td>
                        <td className="mono col-meta">{run.iteration ?? '—'}</td>
                        <td className="mono">{formatTimestamp(run.updated_at)}</td>
                        <td>
                          {isResumableRun(run.status) ? (
                            <button
                              type="button"
                              className="btn btn-small"
                              disabled={!connected || busy.has(run.run_id)}
                              title={!connected ? '连接断开，写操作已禁用' : undefined}
                              onClick={() => resume(run.run_id)}
                            >
                              {busy.has(run.run_id) ? '恢复中…' : '恢复运行'}
                            </button>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {windowed.hiddenCount > 0 && (
              <button
                type="button"
                className="load-more"
                onClick={() => setLimit((value) => value + 100)}
              >
                显示更多（还有 {windowed.hiddenCount} 条）
              </button>
            )}
          </>
        )}

        {route.runId &&
          (detailMissing ? (
            <ErrorState
              message={
                detailResource.state.status === 'error' ? detailResource.state.error : '运行不存在'
              }
              onRetry={detailResource.reload}
            />
          ) : detailLoading ? (
            <LoadingState label="正在加载运行详情…" />
          ) : detailRun || knownDurable ? (
            <RunDetail
              runId={route.runId}
              tab={route.tab}
              run={detailRun}
              durable={knownDurable ?? null}
              active={activeDetail}
              canWrite={connected}
              onCancel={cancel}
              onResume={resume}
              onClose={() => navigateRoute({ runId: undefined })}
              busy={busy.has(route.runId)}
            />
          ) : null)}
      </div>
    </div>
  );
}
