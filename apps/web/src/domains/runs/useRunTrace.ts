/**
 * 运行详情页的 trace 数据/分页：首屏拉取、加载更多、实时事件合并与
 * run 切换时的代次保护。过滤与分页窗口在 run-event-log.ts 的纯函数里，
 * 这里只管取数与合并。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type { DurableRunSummary, RunEvent, RunStatus } from '../../gateway/types';
import { t } from '../../i18n';
import { mergeRunEvents, nextSinceSeq, traceRunId } from '../../state/run-detail';

const EVENT_PAGE_SIZE = 500;

export interface RunTrace {
  /** trace 回放原始事件（不含 live 增量），分页游标基于它。 */
  trace: RunEvent[];
  traceError: { code?: string; message: string } | null;
  traceLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** trace + live 合并后的事件序列（日志页的输入）。 */
  events: RunEvent[];
  sinceSeq: number | undefined;
  liveEvents: RunEvent[];
  coreRunId: string | undefined;
  loadFirstPage: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useRunTrace(
  runId: string,
  tab: 'live' | 'durable',
  run: RunStatus | null,
  durable: DurableRunSummary | null,
  active: boolean,
): RunTrace {
  const { client, hasToken } = useConnection();
  const toast = useToast();
  const snapshot = useEventSnapshot();

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

  // 切换 run：清空旧 trace 与分页状态（页面上的过滤器由日志组件自己重置）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId/coreRunId 变化时重置
  useEffect(() => {
    traceGeneration.current += 1;
    setTrace([]);
    setHasMore(false);
    setTraceError(null);
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
    trace,
    traceError,
    traceLoading,
    loadingMore,
    hasMore,
    events,
    sinceSeq,
    liveEvents,
    coreRunId,
    loadFirstPage,
    loadMore,
  };
}
