/**
 * RunDetail 的 trace 数据/分页/过滤：首屏拉取、加载更多、实时事件合并与
 * run 切换时的代次保护。原 RunDetail 内的 hooks 逐段搬入；依赖数组保持不变。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type { DurableRunSummary, RunEvent, RunStatus } from '../../gateway/types';
import { t } from '../../i18n';
import {
  filterRunEvents,
  groupRunEvents,
  mergeRunEvents,
  nextSinceSeq,
  type RunEventFilter,
  type RunTimelineItem,
  traceRunId,
} from '../../state/run-detail';

export type DetailTab = 'timeline' | 'output' | 'raw';

const EVENT_PAGE_SIZE = 500;

export interface RunTrace {
  view: DetailTab;
  setView: (view: DetailTab) => void;
  filter: RunEventFilter;
  setFilter: (filter: RunEventFilter) => void;
  showInternal: boolean;
  setShowInternal: (update: (value: boolean) => boolean) => void;
  typePrefix: string;
  setTypePrefix: (value: string) => void;
  trace: RunEvent[];
  traceError: { code?: string; message: string } | null;
  traceLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  events: RunEvent[];
  filtered: RunEvent[];
  items: RunTimelineItem[];
  sinceSeq: number | undefined;
  liveEvents: RunEvent[];
  coreRunId: string | undefined;
  loadFirstPage: () => Promise<void>;
  loadMore: () => Promise<void>;
  connected: boolean;
}

export function useRunTrace(
  runId: string,
  tab: 'live' | 'durable',
  run: RunStatus | null,
  durable: DurableRunSummary | null,
  active: boolean,
): RunTrace {
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

  // 0.27 起 `job_id ≡ run_id`，实时事件与列表用同一个 id；旧 gateway 仍可能有 core_run_id。
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

  return {
    view,
    setView,
    filter,
    setFilter,
    showInternal,
    setShowInternal,
    typePrefix,
    setTypePrefix,
    trace,
    traceError,
    traceLoading,
    loadingMore,
    hasMore,
    events,
    filtered,
    items,
    sinceSeq,
    liveEvents,
    coreRunId,
    loadFirstPage,
    loadMore,
    connected,
  };
}
