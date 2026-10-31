/**
 * Runs 页的数据/状态/副作用：列表轮询、事件驱动刷新、过滤、详情轮询、
 * 取消/恢复与命令面板。原 RunsView 内的 hooks 逐段搬入；依赖数组保持不变。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t } from '../../i18n';
import { buildRunPaletteActions } from '../../state/palette-actions';
import {
  filterDurableRuns,
  filterLiveRuns,
  isAlreadyResumedError,
  type RunStatusFilter,
  sortDurableRuns,
  sortLiveRuns,
  takeRuns,
} from '../../state/runs';
import { resourceData, useResource } from '../../state/useResource';
import { useNodeRuns, useRunStore } from '../../stores/runStore';
import { usePolledAction } from '../../stores/usePolledAction';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

export const LIVE_FILTERS: readonly { id: RunStatusFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'runs.filter.all' },
  { id: 'queued', labelKey: 'runs.filter.queued' },
  { id: 'running', labelKey: 'runs.filter.running' },
  { id: 'completed', labelKey: 'runs.filter.completed' },
  { id: 'failed', labelKey: 'runs.filter.failed' },
  { id: 'cancelled', labelKey: 'runs.filter.cancelled' },
];

export const DURABLE_FILTERS: readonly { id: RunStatusFilter; labelKey: string }[] = [
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

export function useRunsPage(route: RunsRoute, navigate: (route: Route) => void) {
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

  return {
    tenantId,
    hasToken,
    connected,
    durableAvailable,
    query,
    setQuery,
    status,
    setStatus,
    limit,
    setLimit,
    agentId,
    setAgentId,
    busy,
    filterList,
    current,
    filtered,
    windowed,
    resourceState,
    reloadResource,
    resourceError,
    loading,
    agentOptions,
    reloadAll,
    detailResource,
    detailRun,
    knownDurable,
    detailMissing,
    detailLoading,
    activeDetail,
    cancel,
    resume,
  };
}
