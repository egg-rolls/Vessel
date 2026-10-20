import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import { useViewportWidth } from '../../app/useViewportWidth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type { PermissionRequest, SessionDetail, SessionInfo } from '../../gateway/types';
import { groupEvents, isGroupPersisted } from '../../state/events';
import type { PaletteItem } from '../../state/palette';
import {
  filterSessions,
  matchesSessionStatus,
  removeSessionFromList,
  renameSessionInList,
  SESSION_PAGE_SIZE,
  type SessionStatusFilter,
  selectionAfterDelete,
  sessionTitle,
  sortSessions,
  takeSessions,
} from '../../state/sessions';
import { useResource } from '../../state/useResource';
import { windowTail } from '../../transcript';
import { Composer } from './Composer';
import { QueuedCard, type QueuedSubmission, RunCard } from './RunCard';
import { SessionHeader } from './SessionHeader';
import { SessionList } from './SessionList';
import { Transcript } from './Transcript';

const TRANSCRIPT_WINDOW = 50;
const QUEUE_POLL_MS = 2000;
const NOT_FOUND_MESSAGE = '会话不存在或已删除';
const NO_PERMISSIONS: readonly PermissionRequest[] = [];

type ChatRoute = Extract<Route, { domain: 'chat' }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = errorMessage(error);
  return code === 'not_found' || message.startsWith('not_found:');
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function ChatView({
  route,
  navigate,
  sessionsOpen,
  onCloseSessions,
}: {
  route: ChatRoute;
  navigate: (route: Route) => void;
  sessionsOpen: boolean;
  onCloseSessions: () => void;
}) {
  const {
    client,
    hasToken,
    connectionState,
    epoch,
    retry,
    features,
    permissions,
    responding,
    now,
    respondPermission,
  } = useConnection();
  const toast = useToast();
  const snapshot = useEventSnapshot();
  const connected = connectionState === 'open' && hasToken;
  const durableFeature = features.includes('durable-resume');

  const selectedId = route.sessionId && route.sessionId !== 'new' ? route.sessionId : null;
  const draftActive = route.sessionId === 'new';

  const [draftId, setDraftId] = useState<string | null>(() =>
    draftActive ? crypto.randomUUID() : null,
  );
  const pendingNewSessions = useRef(new Set<string>());
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 150);
  /** 服务端内容搜索；null = 用本地 title/preview/id 过滤兜底。 */
  const [serverSearch, setServerSearch] = useState<{
    query: string;
    ids: Set<string>;
    snippets: Map<string, string>;
  } | null>(null);
  const [status, setStatus] = useState<SessionStatusFilter>('all');
  const [renderLimit, setRenderLimit] = useState(SESSION_PAGE_SIZE);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<QueuedSubmission[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());
  const [showInternal, setShowInternal] = useState(false);
  const [transcriptLimit, setTranscriptLimit] = useState(TRANSCRIPT_WINDOW);
  const [renameSignal, setRenameSignal] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<{
    live: number;
    durable: number;
    active: number;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const compact = useViewportWidth() <= RAIL_MAX_WIDTH;
  const [nearBottom, setNearBottom] = useState(true);
  const [composerFocus, setComposerFocus] = useState(0);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const drawerRef = useDrawerA11y({
    open: sessionsOpen,
    onClose: onCloseSessions,
    enabled: compact,
    returnFocusId: 'sessions-toggle',
  });
  const queuedRef = useRef(queuedRuns);
  queuedRef.current = queuedRuns;
  const refreshTimer = useRef<number | undefined>(undefined);
  const lastSnapshotVersion = useRef(0);

  // 草稿 id：进入 #/chat/new 时生成一次；离开时丢弃（未发送不落盘）。
  useEffect(() => {
    if (draftActive) {
      if (!draftId) setDraftId(crypto.randomUUID());
      setComposerFocus((value) => value + 1);
    } else if (draftId) {
      setDraftId(null);
    }
  }, [draftActive, draftId]);

  // 会话列表：有 token 就加载（重连期间走 HTTP RPC），15s 轮询；本地副本支持乐观重命名。
  const sessionsResource = useResource({
    load: () => client.listSessions(),
    enabled: hasToken,
    pollMs: 15_000,
    deps: [epoch],
  });
  useEffect(() => {
    if (sessionsResource.state.status === 'success') {
      setSessions(sortSessions(sessionsResource.state.data));
    }
  }, [sessionsResource.state]);

  // 服务端全文搜索：150ms debounce 后切换；旧 gateway/失败时保持本地过滤。
  useEffect(() => {
    const needle = debouncedQuery.trim();
    if (!needle || !hasToken) {
      setServerSearch(null);
      return;
    }
    let cancelled = false;
    void client.searchSessions(needle).then((hits) => {
      if (cancelled) return;
      if (hits === null) {
        setServerSearch(null);
        return;
      }
      setServerSearch({
        query: needle,
        ids: new Set(hits.map((hit) => hit.session_id)),
        snippets: new Map(hits.map((hit) => [hit.session_id, hit.snippet])),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, debouncedQuery, hasToken]);

  const loadDetail = useCallback(async (): Promise<SessionDetail | null> => {
    if (!selectedId) return null;
    try {
      const detail = await client.getSession(selectedId);
      pendingNewSessions.current.delete(selectedId);
      return detail;
    } catch (error) {
      if (isNotFound(error)) {
        // 新会话在首条消息落盘前可能 404：按空历史处理，不伪装成错误。
        if (pendingNewSessions.current.has(selectedId)) {
          return { session_id: selectedId, messages: [] };
        }
        throw new Error(NOT_FOUND_MESSAGE);
      }
      throw error;
    }
  }, [client, selectedId]);

  const detailResource = useResource({
    load: loadDetail,
    enabled: hasToken && Boolean(selectedId),
    deps: [selectedId, epoch],
  });

  // 切换会话重置历史窗口。
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId 变化是重置条件
  useEffect(() => {
    setTranscriptLimit(TRANSCRIPT_WINDOW);
  }, [selectedId]);

  // 抽屉的 Esc / Tab 圈 / 焦点返回 / body 滚动锁由 useDrawerA11y 统一处理。

  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  // 删除确认前统计关联数据：消息数、live/durable runs、活动 run（服务端会拒绝删除活动会话）。
  useEffect(() => {
    if (!deleteTarget) {
      setDeleteCounts(null);
      return;
    }
    let cancelled = false;
    const sessionId = deleteTarget.session_id;
    setDeleteCounts({ live: 0, durable: 0, active: 0, loading: true, error: null });
    void (async () => {
      let live = 0;
      let active = 0;
      let durable = 0;
      let error: string | null = null;
      try {
        const runs = await client.listRuns({ session_id: sessionId });
        live = runs.length;
        active = runs.filter((run) => run.status === 'queued' || run.status === 'running').length;
      } catch (caught) {
        error = errorMessage(caught);
      }
      if (durableFeature) {
        try {
          const checkpoints = await client.listDurableRuns({ session_id: sessionId, limit: 200 });
          durable = checkpoints.length;
          active += checkpoints.filter(
            (run) => run.status === 'running' || run.status === 'interrupted',
          ).length;
        } catch {
          // durable 计数不可用不影响删除确认；服务端仍会做冲突检查。
        }
      }
      if (!cancelled) setDeleteCounts({ live, durable, active, loading: false, error });
    })();
    return () => {
      cancelled = true;
    };
  }, [deleteTarget, client, durableFeature]);

  // 排队位置没有推送事件：只轮询未取消的排队卡片。
  useEffect(() => {
    if (!queuedRuns.some((item) => !item.cancelled)) return;
    const id = window.setInterval(() => {
      for (const item of queuedRef.current) {
        if (item.cancelled) continue;
        client
          .getRunStatus(item.runId)
          .then((runStatus) => {
            setQueuedRuns((prev) => {
              const current = prev.find((entry) => entry.runId === item.runId);
              if (!current || current.cancelled) return prev;
              if (runStatus.status === 'queued') {
                const sessionId = current.sessionId ?? runStatus.session_id;
                if (
                  current.queuePosition === runStatus.queue_position &&
                  current.sessionId === sessionId
                ) {
                  return prev;
                }
                return prev.map((entry) =>
                  entry.runId === item.runId
                    ? {
                        ...entry,
                        ...(runStatus.queue_position !== undefined
                          ? { queuePosition: runStatus.queue_position }
                          : {}),
                        ...(sessionId ? { sessionId } : {}),
                      }
                    : entry,
                );
              }
              if (runStatus.status === 'cancelled') {
                return prev.map((entry) =>
                  entry.runId === item.runId
                    ? { ...entry, cancelling: false, cancelled: true }
                    : entry,
                );
              }
              return prev.filter((entry) => entry.runId !== item.runId);
            });
          })
          .catch(() => {
            // 位置未知时保留卡片，不把轮询失败升级成全局错误。
          });
      }
    }, QUEUE_POLL_MS);
    return () => window.clearInterval(id);
  }, [queuedRuns, client]);

  const seenJobIds = useMemo(
    () =>
      new Set(
        snapshot.entries
          .map((entry) => entry.jobId)
          .filter((jobId): jobId is string => Boolean(jobId)),
      ),
    [snapshot.entries],
  );

  // 事件流接管后移除排队占位卡片。
  useEffect(() => {
    setQueuedRuns((prev) => prev.filter((item) => !seenJobIds.has(item.runId)));
  }, [seenJobIds]);

  const groups = useMemo(
    () => groupEvents(snapshot.entries, showInternal),
    [snapshot.entries, showInternal],
  );

  // 权限请求按 run_id 挂到对应 RunCard；没匹配到 run 的由 AppShell 顶部条提示。
  const permissionsByRun = useMemo(() => {
    const map = new Map<string, PermissionRequest[]>();
    for (const item of permissions) {
      const list = map.get(item.runId);
      if (list) list.push(item);
      else map.set(item.runId, [item]);
    }
    return map;
  }, [permissions]);

  const detailState = detailResource.state;
  const sessionDetail =
    selectedId && 'data' in detailState && detailState.data?.session_id === selectedId
      ? detailState.data
      : null;
  // 已有历史时，刷新失败不能把 transcript 换成错误页；只显示 stale 提示。
  const hydrateError = detailState.status === 'error' && !sessionDetail ? detailState.error : null;
  const hydrateStale = detailState.status === 'error' && sessionDetail ? detailState.error : null;
  const hydrating = Boolean(selectedId) && detailState.status === 'loading' && !sessionDetail;

  const visibleGroups = useMemo(() => {
    if (!selectedId) return [];
    return groups.filter(
      (group) => group.sessionId === selectedId && !isGroupPersisted(group, sessionDetail),
    );
  }, [groups, selectedId, sessionDetail]);

  const visibleQueued = useMemo(
    () => (selectedId ? queuedRuns.filter((item) => item.sessionId === selectedId) : []),
    [queuedRuns, selectedId],
  );

  // 终态/session.saved 后做一次精确刷新（150ms 合并）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在快照版本变化时扫描新增事件
  useEffect(() => {
    if (snapshot.version === lastSnapshotVersion.current) return;
    lastSnapshotVersion.current = snapshot.version;
    const recent = snapshot.entries.slice(-40);
    const needsRefresh = recent.some(({ event }) => {
      if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
      ) {
        return true;
      }
      if (event.type === 'session.saved') {
        const sessionId = (event.data as { session_id?: unknown }).session_id;
        return typeof sessionId === 'string' && sessionId === selectedId;
      }
      return false;
    });
    if (!needsRefresh) return;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      sessionsResource.reload();
      detailResource.reload();
    }, 150);
    return () => window.clearTimeout(refreshTimer.current);
  }, [snapshot.version, selectedId]);

  const refreshAll = useCallback(() => {
    sessionsResource.reload();
    detailResource.reload();
  }, [sessionsResource.reload, detailResource.reload]);
  useRefreshSignal(refreshAll);

  // 命令面板：最近 20 个会话（跨域可搜）+ 当前会话的改名/删除动作（离开 Chat 时清除）。
  const paletteEntities = useMemo(
    () =>
      sessions.slice(0, 20).map((session) => ({
        id: `session-${session.session_id}`,
        group: 'entity' as const,
        label: sessionTitle(session),
        keywords: [session.session_id, session.preview ?? ''],
        hint: '会话',
        run: () => navigate({ domain: 'chat', sessionId: session.session_id }),
      })),
    [sessions, navigate],
  );
  usePaletteEntities('chat-entities', paletteEntities);

  const paletteActions = useMemo<PaletteItem[]>(() => {
    const selected = selectedId
      ? sessions.find((item) => item.session_id === selectedId)
      : undefined;
    if (!selected) return [];
    const title = sessionTitle(selected);
    return [
      {
        id: 'action-rename-session',
        group: 'action',
        label: `重命名会话“${title}”`,
        keywords: ['rename', 'title', selected.session_id],
        hint: '会话',
        run: () => setRenameSignal((value) => value + 1),
      },
      {
        id: 'action-delete-session',
        group: 'action',
        label: `删除会话“${title}”（需确认）`,
        keywords: ['delete', 'remove', selected.session_id],
        hint: '需确认',
        // 打开标准确认框（带消息数/关联 run 计数），不在面板内直接删除。
        run: () => {
          setDeleteError(null);
          setDeleteTarget(selected);
        },
      },
    ];
  }, [sessions, selectedId]);
  usePaletteEntities('chat-actions', paletteActions, { clearOnUnmount: true });

  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);
  const searchQuery = debouncedQuery.trim();
  const activeServerSearch = serverSearch?.query === searchQuery ? serverSearch : null;
  const filteredSessions = useMemo(() => {
    // 服务端命中的会话可能只在消息正文里匹配，不能再叠加本地 title/preview 过滤。
    if (activeServerSearch) {
      return sortedSessions.filter(
        (session) =>
          activeServerSearch.ids.has(session.session_id) && matchesSessionStatus(session, status),
      );
    }
    return filterSessions(sortedSessions, { query: debouncedQuery, status });
  }, [activeServerSearch, sortedSessions, debouncedQuery, status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 查询/过滤变化时回到第一页
  useEffect(() => {
    setRenderLimit(SESSION_PAGE_SIZE);
  }, [debouncedQuery, status]);

  const sessionWindow = takeSessions(filteredSessions, renderLimit);
  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId)
    : undefined;
  const transcriptMessages = sessionDetail?.messages ?? [];
  const visibleTranscript = useMemo(
    () => transcriptMessages.filter((message) => message.role !== 'system'),
    [transcriptMessages],
  );
  const transcriptWindow = useMemo(
    () => windowTail(visibleTranscript, transcriptLimit),
    [visibleTranscript, transcriptLimit],
  );
  const transcriptStart = visibleTranscript.length - transcriptWindow.shown.length;
  const hasTranscript = visibleTranscript.length > 0;
  const truncated = visibleGroups.some((group) => snapshot.truncatedRuns.has(group.runId));

  // 接近底部时跟随新事件；上翻阅读时不拉回。
  // snapshot.version 覆盖流式 token（run 分组数量不变，但文本持续增长）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot.version 是流式追加的显式触发器
  useEffect(() => {
    if (visibleGroups.length === 0 && visibleQueued.length === 0) return;
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [snapshot.version, visibleGroups.length, visibleQueued.length]);

  // 切换会话/历史加载完成后直接展示最新内容。
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId/sessionDetail 变化时跳到底部
  useEffect(() => {
    if (!selectedId) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedId, sessionDetail?.session_id]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance < 96;
    nearBottomRef.current = near;
    setNearBottom(near);
  }, []);

  const scrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  const selectSession = (sessionId: string) => {
    navigate({ domain: 'chat', sessionId });
    onCloseSessions();
  };

  const startNewSession = () => {
    if (draftActive) setDraftId(crypto.randomUUID());
    navigate({ domain: 'chat', sessionId: 'new' });
    onCloseSessions();
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || submitting || !connected) return;
    const targetSessionId = selectedId ?? draftId ?? crypto.randomUUID();
    if (!selectedId) pendingNewSessions.current.add(targetSessionId);
    setSubmitting(true);
    try {
      const result = await client.submitRun(text, targetSessionId);
      setInput('');
      if (!selectedId) navigate({ domain: 'chat', sessionId: targetSessionId });
      if (result.status === 'queued' && !seenJobIds.has(result.run_id)) {
        setQueuedRuns((prev) => [
          ...prev.filter((item) => item.runId !== result.run_id),
          {
            runId: result.run_id,
            sessionId: targetSessionId,
            input: text,
            ...(result.queue_position !== undefined
              ? { queuePosition: result.queue_position }
              : {}),
            submittedAt: Date.now(),
            cancelling: false,
            cancelled: false,
          },
        ]);
        toast.info('已排队');
      }
      sessionsResource.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (group: { jobId?: string }) => {
    const jobId = group.jobId;
    if (!jobId) return;
    setCancelling((prev) => new Set(prev).add(jobId));
    try {
      const result = await client.cancelRun(jobId);
      if (result.cancelled) {
        setCancelledJobs((prev) => new Set(prev).add(jobId));
        toast.success('已请求取消 run');
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const handleCancelQueued = async (runId: string) => {
    setQueuedRuns((prev) =>
      prev.map((item) => (item.runId === runId ? { ...item, cancelling: true } : item)),
    );
    try {
      const result = await client.cancelRun(runId);
      if (result.cancelled) {
        setQueuedRuns((prev) =>
          prev.map((item) =>
            item.runId === runId ? { ...item, cancelling: false, cancelled: true } : item,
          ),
        );
        toast.success('已取消排队');
        window.setTimeout(() => {
          setQueuedRuns((prev) => prev.filter((item) => item.runId !== runId));
        }, 4000);
      } else {
        setQueuedRuns((prev) =>
          prev.map((item) => (item.runId === runId ? { ...item, cancelling: false } : item)),
        );
        toast.error('取消请求未被受理，run 可能已经开始执行');
      }
    } catch (error) {
      setQueuedRuns((prev) =>
        prev.map((item) => (item.runId === runId ? { ...item, cancelling: false } : item)),
      );
      toast.error(errorMessage(error));
    }
  };

  const handleRename = async (sessionId: string, title: string): Promise<boolean> => {
    if (!connected) {
      toast.error('连接断开，暂时无法重命名会话');
      return false;
    }
    const previous = sessions;
    setSessions((list) => renameSessionInList(list, sessionId, title));
    try {
      await client.renameSession(sessionId, title);
      sessionsResource.reload();
      return true;
    } catch (error) {
      setSessions(previous);
      toast.error(`重命名失败：${errorMessage(error)}`);
      return false;
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (!connected) {
      setDeleteError('连接断开，暂时无法删除会话');
      return;
    }
    if ((deleteCounts?.active ?? 0) > 0) {
      setDeleteError('该会话仍有运行中或中断的 run，暂时无法删除。');
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await client.deleteSession(deleteTarget.session_id);
      const next = selectionAfterDelete(selectedId, draftId, deleteTarget.session_id);
      setSessions((list) => removeSessionFromList(list, deleteTarget.session_id));
      setDeleteTarget(null);
      if (next.selectedId === null && next.draftId === null) {
        navigate({ domain: 'chat' });
      }
      toast.success(`已删除会话（runs: ${result.runs_deleted}, events: ${result.events_deleted}）`);
      sessionsResource.reload();
    } catch (error) {
      const code = (error as { code?: string }).code;
      setDeleteError(
        code === 'conflict' ? '该会话仍有运行中或中断的 run，暂时无法删除。' : errorMessage(error),
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  const targetLabel = selectedId
    ? `→ ${selectedSession ? sessionTitle(selectedSession) : selectedId}`
    : '＋ 新会话';

  const drawerA11y = compact ? { role: 'dialog' as const, 'aria-modal': sessionsOpen } : {};

  return (
    <div className="chat-workspace">
      <aside
        {...drawerA11y}
        ref={drawerRef}
        id="chat-sessions"
        className={`chat-session-column ${sessionsOpen ? 'open' : ''}`.trim()}
        aria-label="会话列表"
        inert={compact && !sessionsOpen ? true : undefined}
        aria-hidden={compact && !sessionsOpen ? true : undefined}
      >
        <SessionList
          sessions={sessionWindow.shown}
          filteredCount={filteredSessions.length}
          totalCount={sortedSessions.length}
          hiddenCount={sessionWindow.hiddenCount}
          selectedId={selectedId}
          draftActive={draftActive}
          query={query}
          onQueryChange={setQuery}
          searchSnippets={activeServerSearch?.snippets}
          status={status}
          onStatusChange={setStatus}
          loading={sessionsResource.state.status === 'loading'}
          error={sessionsResource.state.status === 'error' ? sessionsResource.state.error : null}
          onRetry={sessionsResource.reload}
          hasToken={hasToken}
          onSelect={selectSession}
          onNew={startNewSession}
          onRename={handleRename}
          onDelete={(session) => {
            setDeleteError(null);
            setDeleteTarget(session);
          }}
          onViewRuns={(sessionId) => navigate({ domain: 'runs', tab: 'live', sessionId })}
          onShowMore={() => setRenderLimit((value) => value + SESSION_PAGE_SIZE)}
          compact={compact}
          onCloseDrawer={onCloseSessions}
          onOpenConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
          writesDisabled={!connected}
          renameSignal={renameSignal}
        />
      </aside>

      {compact && sessionsOpen && (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label="关闭会话列表"
          onClick={onCloseSessions}
        />
      )}

      <section
        className="conversation"
        aria-label="对话"
        inert={compact && sessionsOpen ? true : undefined}
      >
        <h1 className="sr-only">会话</h1>

        {selectedId ? (
          <SessionHeader
            session={selectedSession ?? null}
            sessionId={selectedId}
            detail={sessionDetail}
            refreshing={detailState.status === 'loading'}
            onRefresh={detailResource.reload}
            onRename={(title) => handleRename(selectedId, title)}
            onDelete={() => {
              if (selectedSession) {
                setDeleteError(null);
                setDeleteTarget(selectedSession);
              }
            }}
            onViewRuns={() => navigate({ domain: 'runs', tab: 'live', sessionId: selectedId })}
            showInternal={showInternal}
            onToggleInternal={() => setShowInternal((value) => !value)}
            writesDisabled={!connected}
          />
        ) : (
          <div className="conversation-head draft-head">
            <div className="conversation-heading">
              <h2 className="conversation-title">{draftActive ? '新会话' : '会话'}</h2>
              <div className="conversation-meta dim">
                {draftActive ? '发送第一条消息后创建会话' : '从左侧选择会话，或新建一个'}
              </div>
            </div>
            <div className="conversation-actions">
              <button type="button" className="btn btn-small" onClick={startNewSession}>
                ＋ 新建会话
              </button>
            </div>
          </div>
        )}

        <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
          {!hasToken ? (
            <EmptyState
              title="连接 gateway 后开始。"
              description="gateway URL 与 token 已移入设置；连接后可新建会话并发送第一条消息。"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
                >
                  配置连接
                </button>
              }
            />
          ) : selectedId ? (
            <>
              {hydrateError ? (
                <ErrorState
                  message={hydrateError}
                  onRetry={detailResource.reload}
                  action={
                    hydrateError === NOT_FOUND_MESSAGE ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => navigate({ domain: 'chat' })}
                      >
                        返回会话
                      </button>
                    ) : undefined
                  }
                />
              ) : hydrating && !hasTranscript ? (
                <LoadingState label="正在加载会话历史…" />
              ) : !hasTranscript && visibleGroups.length === 0 && visibleQueued.length === 0 ? (
                <EmptyState
                  title="该会话暂无对话记录。"
                  description="在下方输入 prompt 继续这个会话。"
                />
              ) : null}

              {hydrateStale && (
                <StaleNotice
                  message={`历史刷新失败，显示已加载的记录：${hydrateStale}`}
                  onRetry={detailResource.reload}
                />
              )}

              {truncated && (
                <StaleNotice message="部分更早的事件已从内存缓冲截断；完整记录请查看运行详情。" />
              )}

              {hasTranscript && (
                <Transcript
                  messages={transcriptWindow.shown}
                  startIndex={transcriptStart}
                  hiddenCount={transcriptWindow.hiddenCount}
                  onLoadEarlier={() => setTranscriptLimit((value) => value + TRANSCRIPT_WINDOW)}
                />
              )}

              {visibleGroups.length > 0 && hasTranscript && (
                <div className="divider-label">
                  <span>继续中</span>
                </div>
              )}
              {visibleGroups.length > 0 && (
                <div className="timeline-hint dim">实时事件 · 按时间正序</div>
              )}
              {visibleGroups.map((group) => (
                <RunCard
                  key={group.runId}
                  group={group}
                  cancelled={group.jobId ? cancelledJobs.has(group.jobId) : false}
                  cancelling={group.jobId ? cancelling.has(group.jobId) : false}
                  hideInput={
                    hasTranscript &&
                    transcriptMessages.some(
                      (message) => message.role === 'user' && message.content === group.input,
                    )
                  }
                  onCancel={(value) => void handleCancel(value)}
                  permissions={permissionsByRun.get(group.runId) ?? NO_PERMISSIONS}
                  permissionNow={now}
                  permissionBusy={responding}
                  onDecidePermission={(requestId, decision, scope) =>
                    void respondPermission(requestId, decision, scope)
                  }
                />
              ))}
              {visibleQueued.map((item) => (
                <QueuedCard
                  key={item.runId}
                  item={item}
                  onCancel={(runId) => void handleCancelQueued(runId)}
                />
              ))}
            </>
          ) : draftActive ? (
            <EmptyState
              title="新会话已就绪。"
              description="发送第一条消息开始；未发送就离开不会创建会话。"
              action={
                <div className="example-prompts">
                  {['解释这个仓库的结构', '列出当前可用的工具及其用途'].map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="example-prompt"
                      onClick={() => setInput(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              }
            />
          ) : (
            <EmptyState
              title={connected ? '还没有选择会话。' : '正在连接 gateway…'}
              description={
                connected
                  ? '新建会话，或从会话列表打开已有会话。'
                  : connectionState === 'reconnecting'
                    ? '连接已断开，正在重连。'
                    : '连接成功后会显示会话列表。'
              }
              action={
                connected ? (
                  <button type="button" className="btn btn-primary" onClick={startNewSession}>
                    新建会话
                  </button>
                ) : connectionState === 'reconnecting' ||
                  connectionState === 'closed' ||
                  connectionState === 'error' ? (
                  <button type="button" className="btn" onClick={retry}>
                    立即重试
                  </button>
                ) : (
                  <LoadingState label="正在连接…" rows={1} />
                )
              }
            />
          )}
          <div ref={bottomRef} />
          {!nearBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>
              回到底部 ↓
            </button>
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void handleSend()}
          submitting={submitting}
          targetLabel={targetLabel}
          hasToken={hasToken}
          connected={connected}
          onOpenConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
          focusSignal={composerFocus}
        />
      </section>

      {deleteTarget && (
        <ConfirmDialog
          title={`删除会话“${sessionTitle(deleteTarget)}”？`}
          body={
            <>
              <p>将同时删除该会话的持久历史、关联 runs 与事件，无法撤销。</p>
              <p className="dim">
                该会话有 {deleteTarget.message_count} 条消息
                {deleteCounts && !deleteCounts.loading
                  ? `、${deleteCounts.live + deleteCounts.durable} 个关联运行记录`
                  : deleteCounts?.loading
                    ? '；正在统计关联运行…'
                    : ''}
                。
              </p>
              {deleteCounts && deleteCounts.active > 0 && (
                <p className="err" role="alert">
                  当前有 {deleteCounts.active} 个运行中/中断的 run，需先结束或恢复后再删除。
                </p>
              )}
              {deleteCounts?.error && <p className="dim">关联运行统计失败：{deleteCounts.error}</p>}
              <p className="dim">存在运行中或中断的 run 时服务端会拒绝删除。</p>
              {!connected && <p className="err">连接已断开，写操作已禁用。</p>}
              {deleteError && (
                <p className="err" role="alert">
                  {deleteError}
                </p>
              )}
            </>
          }
          confirmLabel="删除会话"
          danger
          busy={deleteBusy}
          confirmDisabled={
            !connected || Boolean(deleteCounts?.loading) || (deleteCounts?.active ?? 0) > 0
          }
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
          extra={
            deleteError ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const id = deleteTarget.session_id;
                  setDeleteTarget(null);
                  navigate({ domain: 'runs', tab: 'durable', sessionId: id });
                }}
              >
                查看该会话的运行
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
