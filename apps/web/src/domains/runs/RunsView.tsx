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
import { Button, cn, DataTable, SearchInput, Select } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { DurableRunSummary, RunStatus } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { buildRunPaletteActions } from '../../state/palette-actions';
import {
  filterDurableRuns,
  filterLiveRuns,
  isAlreadyResumedError,
  isCancellableRun,
  isResumableRun,
  type RunStatusFilter,
  runAgentId,
  sortDurableRuns,
  sortLiveRuns,
  takeRuns,
} from '../../state/runs';
import { resourceData, useResource } from '../../state/useResource';
import { useNodeRuns, useRunStore } from '../../stores/runStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { RunDetail } from './RunDetail';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

const LIVE_FILTERS: readonly { id: RunStatusFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'runs.filter.all' },
  { id: 'queued', labelKey: 'runs.filter.queued' },
  { id: 'running', labelKey: 'runs.filter.running' },
  { id: 'completed', labelKey: 'runs.filter.completed' },
  { id: 'failed', labelKey: 'runs.filter.failed' },
  { id: 'cancelled', labelKey: 'runs.filter.cancelled' },
];

const DURABLE_FILTERS: readonly { id: RunStatusFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'runs.filter.all' },
  { id: 'interrupted', labelKey: 'runs.filter.interrupted' },
  { id: 'running', labelKey: 'runs.filter.running' },
  { id: 'completed', labelKey: 'runs.filter.completed' },
  { id: 'failed', labelKey: 'runs.filter.failed' },
  { id: 'cancelled', labelKey: 'runs.filter.cancelled' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 耗时文案。
 *
 * `completed_at` 只有 durable checkpoint 才有，live 快照的已完成 run 没有该字段
 * （`liveRunStatus` 不产出）。**不能**用 `Date.now()` 兜底已结束的 run —— 那会让
 * 耗时随当前时间无限增长（实测显示到 6 万秒）。只有还在跑的 run 才按「现在」算。
 */
function durationLabel(start?: number, end?: number, running = false): string {
  if (start === undefined) return '—';
  const stop = end ?? (running ? Date.now() : undefined);
  if (stop === undefined) return '—';
  const value = Math.max(0, stop - start);
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function RunsView({
  route,
  navigate,
}: {
  route: RunsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { client, connectionState, hasToken, features, epoch, tenantId, eventStore } =
    useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const durableAvailable = hasToken && features.includes('durable-resume');

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<RunStatusFilter>('all');
  const [limit, setLimit] = useState(100);
  /**
   * agent 维度过滤（0.27）。`router.ts` 的 `agentId` 路由参数不在本切片所有权内，
   * 先做成页面内 state：不进 URL，刷新页面即清空；与 status 一样切 tab 时重置。
   */
  const [agentId, setAgentId] = useState<string>('');
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const { current: currentNode } = useNodes();
  const nodeRuns = useNodeRuns(currentNode);
  const liveState = nodeRuns?.live;
  const durableState = nodeRuns?.durable;
  const loadRuns = useRunStore((state) => state.loadRuns);
  const nodeKey = currentNode ? nodeKeyOf(currentNode) : '';

  const reloadLive = useCallback(() => {
    if (currentNode && hasToken) void loadRuns(client, currentNode, 'live');
  }, [client, currentNode, hasToken, loadRuns]);
  const reloadDurable = useCallback(() => {
    if (currentNode && durableAvailable) void loadRuns(client, currentNode, 'durable');
  }, [client, currentNode, durableAvailable, loadRuns]);

  usePolledAction(reloadLive, {
    enabled: hasToken && currentNode !== null,
    deps: [epoch, nodeKey],
    pollMs: 10_000,
  });
  usePolledAction(reloadDurable, {
    enabled: durableAvailable && currentNode !== null,
    deps: [epoch, nodeKey],
    pollMs: 15_000,
  });

  const live = useMemo(() => sortLiveRuns(resourceData(liveState) ?? []), [liveState]);
  const durable = useMemo(() => sortDurableRuns(resourceData(durableState) ?? []), [durableState]);
  const filteredLive = filterLiveRuns(live, {
    query,
    status,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  });
  const filteredDurable = filterDurableRuns(durable, {
    query,
    status,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  });
  const windowedLive = takeRuns(filteredLive, limit);
  const windowedDurable = takeRuns(filteredDurable, limit);

  // agent 过滤下拉的候选：只列当前 tab 内出现过的 agent（升序，去重）。
  // 只取 `agent_id`：旧 gateway 缺失时不列候选，不做 session→agent 的猜测展示。
  const agentOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const run of route.tab === 'live' ? live : durable) {
      if (run.agent_id) ids.add(run.agent_id);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [route.tab, live, durable]);

  // 切换 tab 时回到第一页与「全部」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: route.tab 变化是重置条件
  useEffect(() => {
    setLimit(100);
    setStatus('all');
    setAgentId('');
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
    reloadLive();
    reloadDurable();
    detailResource.reload();
  }, [reloadLive, reloadDurable, detailResource.reload]);
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
        reloadLive();
        if (durableAvailable) reloadDurable();
        if (route.runId) detailResource.reload();
      }, 500);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(eventTimer.current);
    };
  }, [eventStore, reloadLive, reloadDurable, detailResource.reload, durableAvailable, route.runId]);

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
        toast.error(t('runs.toast.disconnectedCancel'));
        return;
      }
      void withBusy(runId, async () => {
        try {
          const result = await client.cancelRun(runId);
          if (result.cancelled) {
            toast.success(t('runs.toast.cancelRequested'));
            reloadLive();
            if (route.runId === runId) detailResource.reload();
          } else {
            toast.error(t('runs.toast.cancelNotAccepted'));
          }
        } catch (error) {
          toast.error(errorMessage(error));
        }
      });
    },
    [client, connected, detailResource.reload, reloadLive, route.runId, toast, withBusy],
  );

  const resume = useCallback(
    (runId: string) => {
      if (!connected) {
        toast.error(t('runs.toast.disconnectedResume'));
        return;
      }
      void withBusy(runId, async () => {
        try {
          await client.resumeRun(runId);
          toast.success(t('runs.toast.resumed'));
          reloadDurable();
        } catch (error) {
          if (isAlreadyResumedError(error)) {
            toast.info(t('runs.toast.resuming'));
            reloadDurable();
          } else {
            toast.error(errorMessage(error));
          }
        }
      });
    },
    [client, connected, reloadDurable, toast, withBusy],
  );

  // 命令面板：最近 run 的实体 + 取消/恢复/打开动作。
  const paletteEntities = useMemo(() => {
    const liveRuns = live.slice(0, 10);
    const durableRuns = durable.slice(0, 10);
    return [
      ...liveRuns.map((run) => ({
        id: `run-${run.run_id}`,
        group: 'entity' as const,
        label: t('runs.palette.live', { id: run.run_id.slice(0, 14) }),
        keywords: [run.session_id, run.status],
        hint: t('palette.hint.run'),
        run: () =>
          navigate({ domain: 'runs', tab: 'live', runId: run.run_id, sessionId: run.session_id }),
      })),
      ...durableRuns.map((run) => ({
        id: `durable-${run.run_id}`,
        group: 'entity' as const,
        label: t('runs.palette.durable', { id: run.run_id.slice(0, 14) }),
        keywords: [run.session_id, run.status, run.agent_id ?? ''],
        hint: t('palette.hint.run'),
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
  const resourceState = route.tab === 'live' ? liveState : durableState;
  const reloadResource = route.tab === 'live' ? reloadLive : reloadDurable;
  const resourceError = resourceState?.status === 'error' ? resourceState.error : null;
  const loading =
    resourceState === undefined ||
    resourceState.status === 'idle' ||
    (resourceState.status === 'loading' && current.length === 0);
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
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={t('runs.title')} description={t('runs.description')} tenantId={tenantId} />
      <SegmentedTabs
        label={t('runs.sourceLabel')}
        tabs={[
          { id: 'live', label: t('runs.source.live') },
          { id: 'durable', label: t('runs.source.durable') },
        ]}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'runs', tab })}
        panelId="runs-panel"
      />

      <div
        className={cn('mt-3.5 flex flex-wrap items-center gap-2', route.runId && 'max-wide:hidden')}
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('runs.searchPlaceholder')}
          ariaLabel={t('runs.searchLabel')}
          className="grow basis-60 max-w-search"
        />
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('runs.statusLegend')}</legend>
          {filterList.map((filter) => (
            <Button
              key={filter.id}
              variant="chip"
              size="small"
              aria-pressed={filter.id === status}
              onClick={() => setStatus(filter.id)}
            >
              {t(filter.labelKey)}
            </Button>
          ))}
        </fieldset>
        <Select
          className="net-select h-control w-auto min-w-32 py-0"
          value={agentId}
          aria-label={t('runs.filterByAgent')}
          onChange={(event) => setAgentId(event.target.value)}
        >
          <option value="">{t('common.all')}</option>
          {agentOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        {route.sessionId && (
          <Button
            variant="chip"
            size="small"
            className="bg-accent-soft text-accent-ink"
            onClick={() => navigateRoute({ sessionId: undefined, runId: undefined })}
            title={t('runs.clearSessionFilter')}
          >
            {t('runs.sessionChip', { session: route.sessionId.slice(0, 12) })} ×
          </Button>
        )}
        {agentId && (
          <Button
            variant="chip"
            size="small"
            className="bg-accent-soft text-accent-ink"
            onClick={() => setAgentId('')}
            title={t('runs.clearAgentFilter')}
          >
            {t('runs.agentChip', { agent: agentId.slice(0, 12) })} ×
          </Button>
        )}
        <Button size="small" onClick={reloadAll} disabled={!hasToken}>
          {t('common.refresh')}
        </Button>
      </div>

      <div
        className="mt-5 flex flex-col gap-4"
        id="runs-panel"
        role="tabpanel"
        aria-label={t('runs.title')}
      >
        <div className={cn('flex flex-col gap-4', route.runId && 'max-wide:hidden')}>
          {!hasToken ? (
            <EmptyState
              title={t('runs.noTokenTitle')}
              action={
                <Button onClick={() => navigate({ domain: 'settings', tab: 'connection' })}>
                  {t('common.configureConnection')}
                </Button>
              }
            />
          ) : route.tab === 'durable' && !durableAvailable ? (
            <NotEnabledState
              title={t('runs.durableDisabledTitle')}
              reason={t('runs.durableDisabledReason')}
              hint={t('runs.durableDisabledHint')}
            />
          ) : (
            <>
              {!connected && current.length > 0 && (
                <StaleNotice message={t('runs.disconnected')} onRetry={reloadAll} />
              )}
              {resourceError && current.length > 0 && (
                <StaleNotice
                  message={t('common.staleData', { detail: resourceError })}
                  onRetry={reloadAll}
                />
              )}

              {resourceError && current.length === 0 ? (
                <ErrorState message={resourceError} onRetry={reloadResource} />
              ) : loading ? (
                <LoadingState label={t('runs.loading')} />
              ) : current.length === 0 ? (
                <EmptyState
                  title={t(route.tab === 'live' ? 'runs.emptyLiveTitle' : 'runs.emptyDurableTitle')}
                  description={t(
                    route.tab === 'live' ? 'runs.emptyLiveDesc' : 'runs.emptyDurableDesc',
                  )}
                  action={
                    route.tab === 'live' ? (
                      <Button
                        variant="primary"
                        onClick={() => navigate({ domain: 'chat', sessionId: 'new' })}
                      >
                        {t('common.newSession')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  title={t('runs.noMatchTitle')}
                  description={t('runs.noMatchDesc')}
                  action={
                    <Button
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                        setAgentId('');
                        navigateRoute({ sessionId: undefined });
                      }}
                    >
                      {t('common.clearFilters')}
                    </Button>
                  }
                />
              ) : route.tab === 'live' ? (
                <DataTable<RunStatus>
                  columns={[
                    {
                      key: 'status',
                      header: t('runs.col.state'),
                      cell: (run) => (
                        <StatusChip
                          status={run.status}
                          label={
                            run.status === 'queued' && run.queue_position !== undefined
                              ? t('chat.run.queuedPosition', {
                                  position: run.queue_position,
                                })
                              : undefined
                          }
                        />
                      ),
                    },
                    {
                      key: 'runId',
                      header: t('runs.col.runId'),
                      cell: (run) => (
                        <Button
                          variant="link"
                          className="font-mono"
                          onClick={() =>
                            navigateRoute({ runId: run.run_id, sessionId: run.session_id })
                          }
                        >
                          {run.run_id.slice(0, 16)}
                        </Button>
                      ),
                    },
                    {
                      key: 'session',
                      header: t('runs.col.session'),
                      hide: 'compact',
                      cellClassName: 'font-mono',
                      cell: (run) => (
                        <Button
                          variant="link"
                          className="font-mono"
                          onClick={() => navigate({ domain: 'chat', sessionId: run.session_id })}
                        >
                          {run.session_id.slice(0, 12)}
                        </Button>
                      ),
                    },
                    {
                      key: 'agent',
                      header: t('runs.col.agent'),
                      hide: 'wide',
                      cellClassName: 'font-mono',
                      cell: (run) => (
                        <Button
                          variant="link"
                          className="font-mono"
                          title={t('runs.filterByAgent')}
                          onClick={() => setAgentId(runAgentId(run) ?? '')}
                        >
                          {runAgentId(run) ?? '—'}
                        </Button>
                      ),
                    },
                    {
                      key: 'started',
                      header: t('runs.col.started'),
                      cellClassName: 'font-mono tabular-nums',
                      cell: (run) => formatTimestamp(run.started_at),
                    },
                    {
                      key: 'duration',
                      header: t('runs.col.duration'),
                      hide: 'compact',
                      cellClassName: 'font-mono tabular-nums',
                      cell: (run) =>
                        durationLabel(
                          run.started_at,
                          run.completed_at,
                          run.status === 'running' || run.status === 'queued',
                        ),
                    },
                    {
                      key: 'tokens',
                      header: 'Tokens',
                      hide: 'wide',
                      cellClassName: 'font-mono tabular-nums',
                      cell: (run) => run.usage?.total_tokens ?? '—',
                    },
                    {
                      key: 'actions',
                      header: t('runs.col.actions'),
                      cell: (run) =>
                        isCancellableRun(run.status) ? (
                          <Button
                            size="small"
                            variant="dangerGhost"
                            disabled={!connected || busy.has(run.run_id)}
                            title={!connected ? t('common.writesDisabled') : undefined}
                            onClick={() => cancel(run.run_id)}
                          >
                            {busy.has(run.run_id) ? t('runs.cancelling') : t('runs.cancel')}
                          </Button>
                        ) : (
                          <span className="text-muted">—</span>
                        ),
                    },
                  ]}
                  rows={windowed.shown as RunStatus[]}
                  rowKey={(run) => run.run_id}
                  activeKey={route.runId}
                />
              ) : (
                <DataTable<DurableRunSummary>
                  columns={[
                    {
                      key: 'status',
                      header: t('runs.col.state'),
                      cell: (run) => <StatusChip status={run.status} />,
                    },
                    {
                      key: 'runId',
                      header: t('runs.col.runId'),
                      cell: (run) => (
                        <Button
                          variant="link"
                          className="font-mono"
                          onClick={() =>
                            navigateRoute({ runId: run.run_id, sessionId: run.session_id })
                          }
                        >
                          {run.run_id.slice(0, 16)}
                        </Button>
                      ),
                    },
                    {
                      key: 'session',
                      header: t('runs.col.session'),
                      hide: 'compact',
                      cellClassName: 'font-mono',
                      cell: (run) => (
                        <Button
                          variant="link"
                          className="font-mono"
                          onClick={() => navigate({ domain: 'chat', sessionId: run.session_id })}
                        >
                          {run.session_id.slice(0, 12)}
                        </Button>
                      ),
                    },
                    {
                      key: 'agent',
                      header: t('runs.col.agent'),
                      hide: 'wide',
                      cellClassName: 'font-mono',
                      cell: (run) => run.agent_id ?? '—',
                    },
                    {
                      key: 'iteration',
                      header: t('runs.col.iter'),
                      hide: 'compact',
                      cellClassName: 'font-mono tabular-nums',
                      cell: (run) => run.iteration ?? '—',
                    },
                    {
                      key: 'updated',
                      header: t('runs.col.updated'),
                      cellClassName: 'font-mono tabular-nums',
                      cell: (run) => formatTimestamp(run.updated_at),
                    },
                    {
                      key: 'actions',
                      header: t('runs.col.actions'),
                      cell: (run) =>
                        isResumableRun(run.status) ? (
                          <Button
                            size="small"
                            disabled={!connected || busy.has(run.run_id)}
                            title={!connected ? t('common.writesDisabled') : undefined}
                            onClick={() => resume(run.run_id)}
                          >
                            {busy.has(run.run_id) ? t('runs.resuming') : t('runs.resume')}
                          </Button>
                        ) : (
                          <span className="text-muted">—</span>
                        ),
                    },
                  ]}
                  rows={windowed.shown as DurableRunSummary[]}
                  rowKey={(run) => run.run_id}
                  activeKey={route.runId}
                />
              )}

              {windowed.hiddenCount > 0 && (
                <Button
                  variant="plain"
                  className="mx-auto mt-2 rounded-full px-3.5 py-2 text-xs text-muted"
                  onClick={() => setLimit((value) => value + 100)}
                >
                  {t('common.showMore', { count: windowed.hiddenCount })}
                </Button>
              )}
            </>
          )}
        </div>

        {route.runId &&
          (detailMissing ? (
            <div className="max-wide:hidden">
              <ErrorState
                message={
                  detailResource.state.status === 'error'
                    ? detailResource.state.error
                    : t('runs.notFound')
                }
                onRetry={detailResource.reload}
              />
            </div>
          ) : detailLoading ? (
            <div className="max-wide:hidden">
              <LoadingState label={t('runs.detailLoading')} />
            </div>
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
