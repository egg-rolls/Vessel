import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { useViewportWidth } from '../../app/useViewportWidth';
import { useVisualViewport } from '../../app/useVisualViewport';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { ResizeHandle } from '../../components/ResizeHandle';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button } from '../../components/ui';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type { AskUserAnswer, PermissionScope, SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { agentsForSession, findAgent, reduceAgents } from '../../state/agents';
import { isGroupPersisted } from '../../state/events';
import { EventGroupCache } from '../../state/group-cache';
import type { PaletteItem } from '../../state/palette';
import {
  isRuntimeMessageVisible,
  runtimeMessageKind,
  useRuntimeVisibility,
} from '../../state/runtime-visibility';
import {
  filterSessions,
  SESSION_PAGE_SIZE,
  selectionAfterDelete,
  sessionTitle,
  sortSessions,
  takeSessions,
} from '../../state/sessions';
import { resourceData, useResource } from '../../state/useResource';
import { resolveUiVisibility, showsInternalEvents } from '../../state/visibility';
import {
  SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE,
  useSessionStore,
} from '../../stores/sessionStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { usePolledAction } from '../../stores/usePolledAction';
import { windowTail } from '../../transcript';
import { ChatWelcome } from './ChatWelcome';
import { Composer } from './Composer';
import { AskPrompt, PermissionPrompt } from './PromptSlots';
import { pendingForSession, pendingQueue } from './pending-permissions';
import { SessionHeader } from './SessionHeader';
import { SessionList } from './SessionList';
import { QueuedNotice, type QueuedSubmission, RunItems } from './StreamItems';
import { SubagentTranscript } from './SubagentTranscript';
import {
  browserSessionStorage,
  clearLastSession,
  decideSessionRestore,
  readLastSession,
  writeLastSession,
} from './session-selection';
import { Transcript } from './Transcript';

const TRANSCRIPT_WINDOW = 50;
const QUEUE_POLL_MS = 2000;
/** 单会话实时组上限：超出时只渲染最近这些 run，并提供运行详情入口。 */
const MAX_LIVE_GROUPS = 200;
const SCROLL_FOLLOW_MS = 100;

type ChatRoute = Extract<Route, { domain: 'chat' }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  panes,
}: {
  route: ChatRoute;
  navigate: (route: Route) => void;
  sessionsOpen: boolean;
  onCloseSessions: () => void;
  panes: PaneResizeApi;
}) {
  const {
    client,
    hasToken,
    connectionState,
    epoch,
    tenantEpoch,
    features,
    tenantId,
    permissions,
    asks,
    hydrateInteractions,
    responding,
    respondPermission,
    respondAsk,
  } = useConnection();
  const toast = useToast();
  const snapshot = useEventSnapshot();
  const { visibility: runtimeVisibility } = useRuntimeVisibility();
  // 键盘弹出时把 visual viewport 尺寸写到根元素，供 dock 上限与外壳高度使用。
  useVisualViewport();
  const connected = connectionState === 'open' && hasToken;
  const durableFeature = features.includes('durable-resume');

  const selectedId = route.sessionId && route.sessionId !== 'new' ? route.sessionId : null;
  const draftActive = route.sessionId === 'new';

  const [draftId, setDraftId] = useState<string | null>(() =>
    draftActive ? crypto.randomUUID() : null,
  );
  const pendingNewSessions = useRef(new Set<string>());
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 150);
  /** 服务端内容搜索；null = 用本地 title/preview/id 过滤兜底。 */
  const [serverSearch, setServerSearch] = useState<{
    query: string;
    ids: Set<string>;
    snippets: Map<string, string>;
  } | null>(null);
  const [renderLimit, setRenderLimit] = useState(SESSION_PAGE_SIZE);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<QueuedSubmission[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());
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
  const [restorePending, setRestorePending] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const followTimer = useRef<number | undefined>(undefined);
  const lastFollowAt = useRef(0);
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

  // 选中会话 / 重连后从服务端补回 pending 交互（浏览器刷新不会重放旧 WS 事件）。
  // ConnectionProvider 的 [epoch, hasToken] effect 负责连接 / 刷新，这里补“切会话”。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是重连后的显式刷新触发器
  useEffect(() => {
    if (!selectedId || !connected) return;
    void hydrateInteractions();
  }, [selectedId, connected, epoch, hydrateInteractions]);

  // 会话列表 / 选中 / detail 统一由 sessionStore 持有；实时事件快照仍走 useEventSnapshot。
  const sessions = useSessionStore((state) => state.sessions);
  const sessionsLoading = useSessionStore((state) => state.loading);
  const sessionsError = useSessionStore((state) => state.error);
  const sessionsLoaded = useSessionStore((state) => state.loaded);
  const sessionDetailData = useSessionStore((state) => state.detail);
  const sessionDetailId = useSessionStore((state) => state.detailId);
  const sessionDetailLoading = useSessionStore((state) => state.detailLoading);
  const sessionDetailError = useSessionStore((state) => state.detailError);
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const loadSessionDetail = useSessionStore((state) => state.loadDetail);
  const selectSessionInStore = useSessionStore((state) => state.select);
  const refreshSessions = useSessionStore((state) => state.refresh);
  const resetSessions = useSessionStore((state) => state.reset);
  const renameSessionLocal = useSessionStore((state) => state.renameSession);
  const removeSessionLocal = useSessionStore((state) => state.removeSession);
  const restoreSessions = useSessionStore((state) => state.setSessions);

  // 路由是选中项的唯一来源；store 只镜像它，切换时由 loadDetail 去重。
  useEffect(() => {
    selectSessionInStore(selectedId);
  }, [selectedId, selectSessionInStore]);

  // 会话列表：有 token 就加载（重连期间走 HTTP RPC），15s 轮询；首轮走去重路径。
  const firstSessionsLoad = useRef(true);
  usePolledAction(
    () => {
      if (!hasToken) return;
      const force = !firstSessionsLoad.current;
      firstSessionsLoad.current = false;
      void loadSessions(client, { epoch, force });
    },
    { enabled: hasToken, pollMs: 15_000, deps: [epoch, tenantEpoch, hasToken] },
  );

  // 与旧 useResource 一致：断开时丢弃列表 / detail。
  useEffect(() => {
    if (!hasToken) resetSessions();
  }, [hasToken, resetSessions]);

  // 离开 Chat / tenant 整体重挂载后不保留上一份快照（等价于旧组件本地 state）。
  useEffect(() => () => resetSessions(), [resetSessions]);

  /** null = 列表尚未加载（或加载失败），此时不能判定记录失效。 */
  const knownSessionIds = useMemo(
    () => (sessionsLoaded ? sessions.map((session) => session.session_id) : null),
    [sessions, sessionsLoaded],
  );
  const sessionsUnavailable = sessionsError !== null && !sessionsLoaded;

  // 只记录真实会话；`new` / 无选择不写。
  useEffect(() => {
    if (!selectedId) return;
    writeLastSession(browserSessionStorage(), tenantId, selectedId);
  }, [tenantId, selectedId]);

  // 路由变成真实 id / `new` 后决策必为 keep，不会重复导航。
  useEffect(() => {
    if (!hasToken) {
      setRestorePending(false);
      return;
    }
    // 坑：sessions.list 可能先于 hello 返回；tenant 未知时读 key 会落到 default，
    // 从而把真实 tenant 的记录判成不存在。
    if (!tenantId) {
      // gateway 不可达时 hello 永不返回：不要在会话区永久显示“恢复中”。
      setRestorePending(connectionState === 'idle' || connectionState === 'connecting');
      return;
    }
    const decision = decideSessionRestore({
      routeSessionId: route.sessionId,
      storedSessionId: readLastSession(browserSessionStorage(), tenantId),
      knownSessionIds,
    });
    if (decision.kind === 'keep') {
      setRestorePending(false);
      return;
    }
    if (decision.kind === 'wait') {
      // 列表失败且无缓存：放弃自动恢复，但保留记录供下次进入重试。
      setRestorePending(!sessionsUnavailable);
      return;
    }
    setRestorePending(false);
    if (decision.kind === 'restore') {
      navigate({ domain: 'chat', sessionId: decision.sessionId });
      return;
    }
    if (decision.clear) clearLastSession(browserSessionStorage(), tenantId);
    navigate({ domain: 'chat', sessionId: 'new' });
  }, [
    hasToken,
    tenantId,
    connectionState,
    route.sessionId,
    knownSessionIds,
    navigate,
    sessionsUnavailable,
  ]);

  // 0.15：信息层级来自 `ui.verbosity` / `ui.showInternalEvents` / `ui.errorLevel`；
  // 读取失败回退 0.13 行为（normal / 隐藏内部事件 / user）。
  const { config: configState } = useConfigStoreApi();
  const visibility = useMemo(
    () => resolveUiVisibility(configState.status === 'success' ? configState.data : null),
    [configState],
  );
  const errorLevel = visibility.errorLevel;
  const showInternal = showsInternalEvents(visibility);
  const groupCache = useRef<EventGroupCache | null>(null);
  if (!groupCache.current) groupCache.current = new EventGroupCache();

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

  // 选中会话 detail：store 去重（同 id 同 epoch 不重复拉，切走再切回才重拉）。
  useEffect(() => {
    if (!hasToken || !selectedId) return;
    void loadSessionDetail(client, selectedId, {
      epoch,
      allowMissing: pendingNewSessions.current.has(selectedId),
    });
  }, [client, epoch, hasToken, selectedId, loadSessionDetail]);

  // 会话出现在列表后，404 容忍（首条消息尚未落盘）不再需要。
  useEffect(() => {
    if (pendingNewSessions.current.size === 0) return;
    for (const session of sessions) pendingNewSessions.current.delete(session.session_id);
  }, [sessions]);

  // 切换会话重置历史窗口。
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId 变化是重置条件
  useEffect(() => {
    setTranscriptLimit(TRANSCRIPT_WINDOW);
  }, [selectedId]);

  // 抽屉的 Esc / Tab 圈 / 焦点返回 / body 滚动锁由 useDrawerA11y 统一处理。

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimer.current);
      window.clearTimeout(followTimer.current);
    },
    [],
  );

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

  // 按 run 增量缓存：50ms 快照只重建受影响的 run，未变化的 RunGroup 引用不变。
  const groups = useMemo(
    () =>
      groupCache.current?.group(
        snapshot.entries,
        showInternal,
        errorLevel,
        snapshot.truncatedSince,
      ) ?? [],
    [snapshot.entries, showInternal, errorLevel, snapshot.truncatedSince],
  );

  // 0.14：子 agent 树与 `?agent=` 深链（纯事件派生，不新增 RPC）。
  const allAgents = useMemo(() => reduceAgents(snapshot.entries), [snapshot.entries]);
  const sessionAgents = useMemo(
    () => (selectedId ? agentsForSession(allAgents, selectedId) : []),
    [allAgents, selectedId],
  );
  const activeAgent = selectedId && route.agent ? findAgent(sessionAgents, route.agent) : undefined;

  // 会话头上下文长度：agents.tree 主 agent 的 context_used；运行中 5s 轮询。
  const sessionRunning =
    selectedId !== null &&
    (sessions.some(
      (session) => session.session_id === selectedId && session.status === 'running',
    ) ||
      sessionAgents.some((node) => node.state === 'running'));
  const contextResource = useResource<{
    sessionId: string;
    used: number;
    max?: number;
  } | null>({
    load: async () => {
      if (!selectedId) return null;
      const tree = await client.listAgentsTree({ session_id: selectedId });
      const main = tree.nodes
        .filter((node) => node.id === selectedId || node.session_id === selectedId)
        .sort((a, b) => a.depth - b.depth)[0];
      if (!main || main.context_used === undefined) return null;
      return {
        sessionId: selectedId,
        used: main.context_used,
        ...(main.context_max !== undefined ? { max: main.context_max } : {}),
      };
    },
    enabled: hasToken && Boolean(selectedId),
    ...(sessionRunning ? { pollMs: 5000 } : {}),
    deps: [selectedId, epoch, sessionRunning],
  });
  const contextData = resourceData(contextResource.state);
  const contextUsage =
    selectedId && contextData?.sessionId === selectedId ? contextData : undefined;

  // detail 只认属于当前选中项的那一份（切走时旧响应不能串到新会话）。
  const currentDetailError = sessionDetailId === selectedId ? sessionDetailError : null;
  const sessionDetail =
    selectedId && sessionDetailId === selectedId && sessionDetailData?.session_id === selectedId
      ? sessionDetailData
      : null;
  // 已有历史时，刷新失败不能把 transcript 换成错误页；只显示 stale 提示。
  const hydrateError = !sessionDetail ? currentDetailError : null;
  const hydrateStale = sessionDetail ? currentDetailError : null;
  const hydrating =
    Boolean(selectedId) && sessionDetailId === selectedId && sessionDetailLoading && !sessionDetail;

  // 已删除的会话不能再被记录恢复；只清记录，不改变当前错误页。
  useEffect(() => {
    if (hydrateError !== NOT_FOUND_MESSAGE || !selectedId) return;
    const storage = browserSessionStorage();
    if (readLastSession(storage, tenantId) === selectedId) clearLastSession(storage, tenantId);
  }, [hydrateError, selectedId, tenantId]);

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
  // 单会话实时组上限：长会话只渲染最近 200 个 run，其余指向运行详情。
  const hiddenLiveGroups = Math.max(0, visibleGroups.length - MAX_LIVE_GROUPS);
  const renderedGroups =
    hiddenLiveGroups > 0 ? visibleGroups.slice(-MAX_LIVE_GROUPS) : visibleGroups;

  // 0.18：停止入口固定在底部 Composer 区域，只对当前会话仍在跑的 run 出现。
  const runningGroup = useMemo(
    () =>
      renderedGroups.find(
        (group) => group.status === 'running' && group.jobId && !cancelledJobs.has(group.jobId),
      ) ?? null,
    [renderedGroups, cancelledJobs],
  );
  const stopBusy = runningGroup?.jobId ? cancelling.has(runningGroup.jobId) : false;

  // 0.18：当前会话的 pending 固定落在 Composer 槽位，不再挂到运行段或页面顶部。
  // 缺 sessionId 的旧流请求按 run 归属补判；run 终态时 ConnectionProvider 会清掉请求。
  const sessionRunIds = useMemo(
    () => new Set(visibleGroups.map((group) => group.runId)),
    [visibleGroups],
  );
  const sessionPermissions = useMemo(
    () => pendingForSession(permissions, selectedId, sessionRunIds),
    [permissions, selectedId, sessionRunIds],
  );
  const sessionAsks = useMemo(
    () => pendingForSession(asks, selectedId, sessionRunIds),
    [asks, selectedId, sessionRunIds],
  );
  // 串行处理：队列按 requestedAt 排序，ask 按问题拆项；槽位只渲染第一项。
  const pendingItems = useMemo(
    () => pendingQueue(sessionPermissions, sessionAsks),
    [sessionPermissions, sessionAsks],
  );
  const pendingItem = pendingItems[0] ?? null;
  // 队列摘要：活动项之后的标签；ask 内部按当前 questionIndex 再偏移（PromptSlots）。
  // 不 memo：locale 变化时标签必须跟着重算。
  const queueChips = pendingItems.slice(1, 13).map((item) =>
    item.kind === 'permission'
      ? {
          key: item.key,
          label: t('pending.queue.permission', { tool: item.request.tool }),
        }
      : {
          key: item.key,
          label: t('pending.queue.ask', { index: item.questionIndex + 1 }),
        },
  );

  // 会话列表徽标：其他会话的 pending 只计数，不渲染完整卡片。
  const pendingBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of [...permissions, ...asks]) {
      if (!item.sessionId) continue;
      counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [permissions, asks]);

  // 槽位从待处理切回输入框时把焦点还给 Composer。
  const pendingActive = pendingItems.length > 0;
  const pendingWasActive = useRef(false);
  useEffect(() => {
    if (pendingWasActive.current && !pendingActive) setComposerFocus((value) => value + 1);
    pendingWasActive.current = pendingActive;
  }, [pendingActive]);

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
      void refreshSessions(client, {
        epoch,
        allowMissing: selectedId ? pendingNewSessions.current.has(selectedId) : false,
      });
    }, 150);
    return () => window.clearTimeout(refreshTimer.current);
  }, [snapshot.version, selectedId, client, epoch, refreshSessions]);

  const refreshAll = useCallback(() => {
    void refreshSessions(client, {
      epoch,
      allowMissing: selectedId ? pendingNewSessions.current.has(selectedId) : false,
    });
  }, [client, epoch, refreshSessions, selectedId]);
  useRefreshSignal(refreshAll);

  const reloadDetail = useCallback(() => {
    if (!selectedId) return;
    void loadSessionDetail(client, selectedId, {
      epoch,
      force: true,
      allowMissing: pendingNewSessions.current.has(selectedId),
    });
  }, [client, epoch, loadSessionDetail, selectedId]);

  // 命令面板：最近 20 个会话（跨域可搜）+ 当前会话的改名/删除动作（离开 Chat 时清除）。
  const paletteEntities = useMemo(
    () =>
      sessions.slice(0, 20).map((session) => ({
        id: `session-${session.session_id}`,
        group: 'entity' as const,
        label: sessionTitle(session),
        keywords: [session.session_id, session.preview ?? ''],
        hint: t('palette.hint.session'),
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
        label: t('chat.palette.rename', { title }),
        keywords: ['rename', 'title', selected.session_id],
        hint: t('palette.hint.session'),
        run: () => setRenameSignal((value) => value + 1),
      },
      {
        id: 'action-delete-session',
        group: 'action',
        label: t('chat.palette.delete', { title }),
        keywords: ['delete', 'remove', selected.session_id],
        hint: t('palette.hint.confirm'),
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
      return sortedSessions.filter((session) => activeServerSearch.ids.has(session.session_id));
    }
    return filterSessions(sortedSessions, { query: debouncedQuery });
  }, [activeServerSearch, sortedSessions, debouncedQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 查询变化时回到第一页
  useEffect(() => {
    setRenderLimit(SESSION_PAGE_SIZE);
  }, [debouncedQuery]);

  const sessionWindow = takeSessions(filteredSessions, renderLimit);
  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId)
    : undefined;
  const transcriptMessages = sessionDetail?.messages ?? [];
  // Runtime context (`vessel:*`) is model-only; hide it unless the user opts in.
  const visibleTranscript = useMemo(
    () =>
      transcriptMessages.filter((message) => {
        if (message.role === 'system') return false;
        const kind = runtimeMessageKind(message);
        return kind === undefined || isRuntimeMessageVisible(runtimeVisibility, kind);
      }),
    [transcriptMessages, runtimeVisibility],
  );
  const transcriptWindow = useMemo(
    () => windowTail(visibleTranscript, transcriptLimit),
    [visibleTranscript, transcriptLimit],
  );
  const transcriptStart = visibleTranscript.length - transcriptWindow.shown.length;
  const hasTranscript = visibleTranscript.length > 0;
  const truncated = visibleGroups.some((group) => snapshot.truncatedRuns.has(group.runId));

  // 接近底部时跟随新事件；50ms 合批下再节流到 ~100ms，且不用 smooth scroll
  // （流式 token 期间连续 smooth 会堆积动画）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot.version 是流式追加的显式触发器
  useEffect(() => {
    if (renderedGroups.length === 0 && visibleQueued.length === 0) return;
    if (!nearBottomRef.current) return;
    const nowMs = Date.now();
    const remaining = SCROLL_FOLLOW_MS - (nowMs - lastFollowAt.current);
    if (remaining <= 0) {
      lastFollowAt.current = nowMs;
      window.clearTimeout(followTimer.current);
      followTimer.current = undefined;
      bottomRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    if (followTimer.current !== undefined) return;
    followTimer.current = window.setTimeout(() => {
      followTimer.current = undefined;
      if (!nearBottomRef.current) return;
      lastFollowAt.current = Date.now();
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }, remaining);
  }, [snapshot.version, renderedGroups.length, visibleQueued.length]);

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

  // dock 增高 / 缩短（卡牌出现、切题、输入框变高）会改变滚动容器的高度：
  // 用户原本贴底时保持贴底；已离开底部则不抢滚动位置。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(element);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
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
        toast.info(t('chat.toast.queued'));
      }
      void loadSessions(client, { epoch, force: true });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  // 引用保持稳定：memo(RunItems) 依赖这几个回调，避免每个 token 让全部实时项重渲染。
  const handleCancel = useCallback(
    async (group: { jobId?: string }) => {
      const jobId = group.jobId;
      if (!jobId) return;
      setCancelling((prev) => new Set(prev).add(jobId));
      try {
        const result = await client.cancelRun(jobId);
        if (result.cancelled) {
          setCancelledJobs((prev) => new Set(prev).add(jobId));
          toast.success(t('chat.toast.cancelRequested'));
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
    },
    [client, toast],
  );

  const handleDecidePermission = useCallback(
    (requestId: string, decision: 'allow' | 'deny', scope: PermissionScope) => {
      void respondPermission(requestId, decision, scope);
    },
    [respondPermission],
  );

  const handleRespondAsk = useCallback(
    (requestId: string, answers: AskUserAnswer[]) => {
      void respondAsk(requestId, answers);
    },
    [respondAsk],
  );

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
        toast.success(t('chat.toast.queueCancelled'));
        window.setTimeout(() => {
          setQueuedRuns((prev) => prev.filter((item) => item.runId !== runId));
        }, 4000);
      } else {
        setQueuedRuns((prev) =>
          prev.map((item) => (item.runId === runId ? { ...item, cancelling: false } : item)),
        );
        toast.error(t('chat.toast.cancelNotAccepted'));
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
      toast.error(t('chat.toast.disconnectedRename'));
      return false;
    }
    const previous = sessions;
    renameSessionLocal(sessionId, title);
    try {
      await client.renameSession(sessionId, title);
      void loadSessions(client, { epoch, force: true });
      return true;
    } catch (error) {
      restoreSessions(previous);
      toast.error(t('chat.toast.renameFailed', { detail: errorMessage(error) }));
      return false;
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (!connected) {
      setDeleteError(t('chat.toast.disconnectedDelete'));
      return;
    }
    if ((deleteCounts?.active ?? 0) > 0) {
      setDeleteError(t('chat.toast.activeRuns'));
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await client.deleteSession(deleteTarget.session_id);
      const next = selectionAfterDelete(selectedId, draftId, deleteTarget.session_id);
      const storage = browserSessionStorage();
      if (readLastSession(storage, tenantId) === deleteTarget.session_id) {
        clearLastSession(storage, tenantId);
      }
      removeSessionLocal(deleteTarget.session_id);
      setDeleteTarget(null);
      if (next.selectedId === null && next.draftId === null) {
        navigate({ domain: 'chat', sessionId: 'new' });
      }
      toast.success(
        t('chat.toast.deleted', {
          runs: result.runs_deleted,
          events: result.events_deleted,
        }),
      );
      void loadSessions(client, { epoch, force: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      setDeleteError(code === 'conflict' ? t('chat.toast.activeRuns') : errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const targetLabel = selectedId
    ? t('chat.target.session', {
        title: selectedSession ? sessionTitle(selectedSession) : selectedId,
      })
    : t('chat.target.new');

  const drawerA11y = compact ? { role: 'dialog' as const, 'aria-modal': sessionsOpen } : {};

  return (
    <div className="chat-workspace">
      <aside
        {...drawerA11y}
        ref={drawerRef}
        id="chat-sessions"
        className={`chat-session-column ${sessionsOpen ? 'open' : ''}`.trim()}
        aria-label={t('chat.main.sessionsLabel')}
        inert={compact && !sessionsOpen ? true : undefined}
        aria-hidden={compact && !sessionsOpen ? true : undefined}
      >
        <SessionList
          sessions={sessionWindow.shown}
          hiddenCount={sessionWindow.hiddenCount}
          selectedId={selectedId}
          draftActive={draftActive}
          pendingBySession={pendingBySession}
          query={query}
          onQueryChange={setQuery}
          searchSnippets={activeServerSearch?.snippets}
          loading={sessionsLoading}
          error={sessionsError}
          onRetry={() => void loadSessions(client, { epoch, force: true })}
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
        {!panes.disabled('sessions') && (
          <ResizeHandle
            pane="sessions"
            api={panes}
            label={t('resize.sessions')}
            className="resize-handle resize-handle-sessions"
          />
        )}
      </aside>

      {compact && sessionsOpen && (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label={t('nav.closeSessions')}
          onClick={onCloseSessions}
        />
      )}

      <section
        className="conversation"
        aria-label={t('chat.main.conversationLabel')}
        inert={compact && sessionsOpen ? true : undefined}
      >
        <h1 className="sr-only">{t('chat.main.heading')}</h1>
        {!panes.disabled('chat') && (
          <ResizeHandle
            pane="chat"
            api={panes}
            label={t('resize.chat')}
            className="resize-handle resize-handle-chat"
          />
        )}

        {selectedId ? (
          <SessionHeader
            session={selectedSession ?? null}
            sessionId={selectedId}
            detail={sessionDetail}
            contextUsage={contextUsage}
            agents={sessionAgents}
            activeAgentId={activeAgent?.id}
            onSelectAgent={(agentId) =>
              navigate({
                domain: 'chat',
                sessionId: selectedId,
                ...(agentId ? { agent: agentId } : {}),
              })
            }
          />
        ) : (
          <div className="conversation-head draft-head">
            <div className="conversation-heading">
              <h2 className="conversation-title">
                {draftActive ? t('chat.draft.title') : t('nav.domain.chat')}
              </h2>
              <div className="conversation-meta text-muted">
                {draftActive ? t('chat.draft.meta') : t('chat.draft.pickSession')}
              </div>
            </div>
          </div>
        )}

        <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
          {!hasToken ? (
            <EmptyState
              title={t('chat.empty.noConnectionTitle')}
              description={t('chat.empty.noConnectionDesc')}
              action={
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
                >
                  {t('common.configureConnection')}
                </Button>
              }
            />
          ) : selectedId ? (
            <>
              {hydrateError ? (
                <ErrorState
                  message={hydrateError === NOT_FOUND_MESSAGE ? t('chat.notFound') : hydrateError}
                  onRetry={reloadDetail}
                  action={
                    hydrateError === NOT_FOUND_MESSAGE ? (
                      <Button type="button" onClick={() => navigate({ domain: 'chat' })}>
                        {t('breadcrumb.chat')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : hydrating && !hasTranscript ? (
                <LoadingState label={t('chat.loadingHistory')} />
              ) : !hasTranscript &&
                visibleGroups.length === 0 &&
                visibleQueued.length === 0 &&
                !activeAgent ? (
                <EmptyState
                  title={t('chat.empty.noHistoryTitle')}
                  description={t('chat.empty.noHistoryDesc')}
                />
              ) : null}

              {hydrateStale && (
                <StaleNotice
                  message={t('chat.staleHistory', { detail: hydrateStale })}
                  onRetry={reloadDetail}
                />
              )}

              {truncated && <StaleNotice message={t('chat.truncated')} />}

              {!activeAgent && hiddenLiveGroups > 0 && (
                <StaleNotice
                  message={t('chat.run.hiddenEarlier', {
                    shown: MAX_LIVE_GROUPS,
                    hidden: hiddenLiveGroups,
                  })}
                />
              )}

              {/* 0.18：历史消息与实时 run 的展开项共享同一个列表，没有 run 边界。 */}
              {hasTranscript ||
              (!activeAgent && (renderedGroups.length > 0 || visibleQueued.length > 0)) ? (
                <Transcript
                  messages={transcriptWindow.shown}
                  startIndex={transcriptStart}
                  hiddenCount={transcriptWindow.hiddenCount}
                  onLoadEarlier={() => setTranscriptLimit((value) => value + TRANSCRIPT_WINDOW)}
                >
                  {!activeAgent &&
                    renderedGroups.map((group) => (
                      <RunItems
                        key={group.runId}
                        group={group}
                        cancelled={group.jobId ? cancelledJobs.has(group.jobId) : false}
                        hideInput={
                          hasTranscript &&
                          transcriptMessages.some(
                            (message) => message.role === 'user' && message.content === group.input,
                          )
                        }
                        verbosity={visibility.verbosity}
                      />
                    ))}
                  {!activeAgent &&
                    visibleQueued.map((item) => (
                      <QueuedNotice
                        key={item.runId}
                        item={item}
                        onCancel={(runId) => void handleCancelQueued(runId)}
                      />
                    ))}
                </Transcript>
              ) : null}

              {activeAgent && (
                <SubagentTranscript
                  agent={activeAgent}
                  entries={snapshot.entries}
                  errorLevel={errorLevel}
                  verbosity={visibility.verbosity}
                />
              )}
            </>
          ) : draftActive ? (
            <ChatWelcome />
          ) : restorePending ? (
            <LoadingState label={t('chat.restoringSession')} />
          ) : null}
          <div ref={bottomRef} />
          {!nearBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>
              {t('chat.toBottom')}
            </button>
          )}
        </div>

        {pendingItem && pendingItem.kind === 'permission' ? (
          <PermissionPrompt
            key={pendingItem.request.requestId}
            request={pendingItem.request}
            more={pendingItems.length - 1}
            busy={responding.has(pendingItem.request.requestId)}
            connected={connected}
            onStop={connected && runningGroup ? () => void handleCancel(runningGroup) : undefined}
            stopping={stopBusy}
            queue={queueChips}
            onDecide={(decision, scope) =>
              handleDecidePermission(pendingItem.request.requestId, decision, scope)
            }
          />
        ) : pendingItem && pendingItem.kind === 'ask' ? (
          <AskPrompt
            key={pendingItem.request.requestId}
            request={pendingItem.request}
            otherPending={Math.max(
              0,
              pendingItems.length - Math.max(1, pendingItem.request.questions.length),
            )}
            busy={responding.has(pendingItem.request.requestId)}
            connected={connected}
            onStop={connected && runningGroup ? () => void handleCancel(runningGroup) : undefined}
            stopping={stopBusy}
            queue={queueChips}
            onSubmit={(answers) => handleRespondAsk(pendingItem.request.requestId, answers)}
            onCancel={() => handleRespondAsk(pendingItem.request.requestId, [])}
          />
        ) : (
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
            onStop={connected && runningGroup ? () => void handleCancel(runningGroup) : undefined}
            stopping={stopBusy}
          />
        )}
      </section>

      {deleteTarget && (
        <ConfirmDialog
          title={t('chat.delete.title', { title: sessionTitle(deleteTarget) })}
          body={
            <>
              <p>{t('chat.delete.body')}</p>
              <p className="text-muted">
                {t('chat.delete.counts', { messages: deleteTarget.message_count })}
                {deleteCounts && !deleteCounts.loading
                  ? t('chat.delete.runsCount', {
                      count: deleteCounts.live + deleteCounts.durable,
                    })
                  : deleteCounts?.loading
                    ? t('chat.delete.counting')
                    : ''}
              </p>
              {deleteCounts && deleteCounts.active > 0 && (
                <p className="text-danger" role="alert">
                  {t('chat.delete.activeRuns', { count: deleteCounts.active })}
                </p>
              )}
              {deleteCounts?.error && (
                <p className="text-muted">
                  {t('chat.delete.statsFailed', { detail: deleteCounts.error })}
                </p>
              )}
              <p className="text-muted">{t('chat.delete.serverReject')}</p>
              {!connected && <p className="text-danger">{t('chat.delete.disconnected')}</p>}
              {deleteError && (
                <p className="text-danger" role="alert">
                  {deleteError}
                </p>
              )}
            </>
          }
          confirmLabel={t('chat.delete.confirm')}
          danger
          busy={deleteBusy}
          confirmDisabled={
            !connected || Boolean(deleteCounts?.loading) || (deleteCounts?.active ?? 0) > 0
          }
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
          extra={
            deleteError ? (
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  const id = deleteTarget.session_id;
                  setDeleteTarget(null);
                  navigate({ domain: 'runs', tab: 'durable', sessionId: id });
                }}
              >
                {t('chat.delete.viewRuns')}
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
