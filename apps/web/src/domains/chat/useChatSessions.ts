import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { useToast } from '../../components/ToastProvider';
import type { ConnectionState, GatewayClient } from '../../gateway/client';
import type { NodeView } from '../../gateway/NodeProvider';
import type { TeamControl } from '../../gateway/team-control';
import type { AskUserRequest, PermissionRequest, SessionDetail } from '../../gateway/types';
import { t } from '../../i18n';
import type { PaletteItem } from '../../state/palette';
import {
  filterSessions,
  SESSION_PAGE_SIZE,
  sessionTitle,
  sortSessions,
  takeSessions,
} from '../../state/sessions';
import { resourceData } from '../../state/useResource';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePolledAction } from '../../stores/usePolledAction';
import { errorMessage } from './errors';
import { findMainSession, type MainSession, primaryBodySessions } from './main-session';
import { sessionAgentAddresses } from './SessionList';
import {
  browserSessionStorage,
  clearLastSession,
  decideSessionRestore,
  readLastSession,
  writeLastSession,
} from './session-selection';
import { useSessionDelete } from './useSessionDelete';

/** Roster 与 Agents 域保持一致：会话行的 agent 地址来自同一份 store。 */
const ROSTER_POLL_MS = 20_000;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface UseChatSessionsOptions {
  client: GatewayClient;
  hasToken: boolean;
  connectionState: ConnectionState;
  epoch: number;
  tenantEpoch: number;
  tenantId: string | null;
  selectedId: string | null;
  routeSessionId: string | undefined;
  durableFeature: boolean;
  connected: boolean;
  navigate: (route: Route) => void;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  nodes: readonly NodeView[];
  teamControl: (node: NodeView) => TeamControl;
  loadRoster: (
    nodes: readonly NodeView[],
    teamControl: (node: NodeView) => TeamControl,
  ) => Promise<void>;
  pendingNewSessions: { current: Set<string> };
}

/**
 * 会话域状态：列表 / roster 轮询、恢复上次会话、搜索与分页、detail、
 * 重命名与删除。所有副作用、依赖与轮询节奏与原 ChatView 保持一致。
 */
export function useChatSessions({
  client,
  hasToken,
  connectionState,
  epoch,
  tenantEpoch,
  tenantId,
  selectedId,
  routeSessionId,
  durableFeature,
  connected,
  navigate,
  permissions,
  asks,
  nodes,
  teamControl,
  loadRoster,
  pendingNewSessions,
}: UseChatSessionsOptions) {
  const toast = useToast();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 150);
  /** 服务端内容搜索；null = 用本地 title/preview/id 过滤兜底。 */
  const [serverSearch, setServerSearch] = useState<{
    query: string;
    ids: Set<string>;
    snippets: Map<string, string>;
  } | null>(null);
  const [renderLimit, setRenderLimit] = useState(SESSION_PAGE_SIZE);
  const [renameSignal, setRenameSignal] = useState(0);
  const [restorePending, setRestorePending] = useState(false);

  // 会话列表 / 选中 / detail 统一由 sessionStore 持有；实时事件快照仍走 useEventSnapshot。
  const sessions = useSessionStore((state) => state.sessions);
  const sessionsLoading = useSessionStore((state) => state.loading);
  const sessionsError = useSessionStore((state) => state.error);
  const sessionsLoaded = useSessionStore((state) => state.loaded);
  const sessionDetailData = useSessionStore((state) => state.detail);
  const sessionDetailId = useSessionStore((state) => state.detailId);
  const sessionDetailLoading = useSessionStore((state) => state.detailLoading);
  const sessionDetailError = useSessionStore((state) => state.detailError);
  const rosterState = useAgentStore((state) => state.roster);
  const rosters = useMemo(() => resourceData(rosterState) ?? [], [rosterState]);
  const agentAddresses = useMemo(() => sessionAgentAddresses(rosters), [rosters]);
  // 默认会话 = `main` 的 primary body（0.27）；roster 拿不到 main 时为 null，
  // 此时保持旧行为（草稿态发送不带 session_id，由服务端解析）。
  const mainSession = useMemo<MainSession | null>(() => {
    // 默认会话属于当前节点；没有 current 标记（单节点 / 测试）时退回第一份 roster。
    const current = rosters.find((roster) => roster.node.current) ?? rosters[0];
    return findMainSession(current?.agents ?? []);
  }, [rosters]);
  // 会话行 body 归属：`bodies` 缺省时为空集合，列表完全退化为现状。
  const primarySessionIds = useMemo(() => primaryBodySessions(rosters), [rosters]);
  /** 默认会话入口：只在 main primary body 还没出现在**完整**列表里时提供（不受窗口化影响）。 */
  const defaultSessionEntry = useMemo(() => {
    if (!mainSession) return undefined;
    if (sessions.some((session) => session.session_id === mainSession.sessionId)) return undefined;
    return {
      sessionId: mainSession.sessionId,
      label: mainSession.name,
      bodyCount: mainSession.bodies.length,
    };
  }, [mainSession, sessions]);
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const loadSessionDetail = useSessionStore((state) => state.loadDetail);
  const selectSessionInStore = useSessionStore((state) => state.select);
  const refreshSessions = useSessionStore((state) => state.refresh);
  const resetSessions = useSessionStore((state) => state.reset);
  const renameSessionLocal = useSessionStore((state) => state.renameSession);
  const restoreSessions = useSessionStore((state) => state.setSessions);

  const deleteApi = useSessionDelete({
    client,
    durableFeature,
    connected,
    epoch,
    tenantId,
    selectedId,
    loadSessions,
    navigate,
  });

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

  // 会话列表第二行来自 agentStore roster（Agents 域同一份数据）。
  const rosterNodeKeys = nodes.map((node) => node.nodeId ?? node.name).join(',');
  usePolledAction(
    () => {
      if (!hasToken) return;
      void loadRoster(nodes, teamControl);
    },
    {
      enabled: hasToken && nodes.length > 0,
      pollMs: ROSTER_POLL_MS,
      deps: [epoch, tenantEpoch, hasToken, rosterNodeKeys],
    },
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
      routeSessionId,
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
    routeSessionId,
    knownSessionIds,
    navigate,
    sessionsUnavailable,
  ]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingNewSessions 是 ref，.current 读取不进依赖
  useEffect(() => {
    if (!hasToken || !selectedId) return;
    void loadSessionDetail(client, selectedId, {
      epoch,
      allowMissing: pendingNewSessions.current.has(selectedId),
    });
  }, [client, epoch, hasToken, selectedId, loadSessionDetail]);

  // 会话出现在列表后，404 容忍（首条消息尚未落盘）不再需要。
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingNewSessions 是 ref，.current 读取不进依赖
  useEffect(() => {
    if (pendingNewSessions.current.size === 0) return;
    for (const session of sessions) pendingNewSessions.current.delete(session.session_id);
  }, [sessions]);

  // 会话列表徽标：其他会话的 pending 只计数，不渲染完整卡片。
  const pendingBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of [...permissions, ...asks]) {
      if (!item.sessionId) continue;
      counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [permissions, asks]);

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
        run: () => deleteApi.openDelete(selected),
      },
    ];
  }, [sessions, selectedId, deleteApi.openDelete]);
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
  // detail 只认属于当前选中项的那一份（切走时旧响应不能串到新会话）。
  const sessionDetail: SessionDetail | null =
    selectedId && sessionDetailId === selectedId && sessionDetailData?.session_id === selectedId
      ? sessionDetailData
      : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingNewSessions 是 ref，.current 读取不进依赖
  const refreshAll = useCallback(() => {
    void refreshSessions(client, {
      epoch,
      allowMissing: selectedId ? pendingNewSessions.current.has(selectedId) : false,
    });
  }, [client, epoch, refreshSessions, selectedId]);
  useRefreshSignal(refreshAll);

  const retryLoad = () => {
    void loadSessions(client, { epoch, force: true });
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

  return {
    sessions,
    sessionsLoading,
    sessionsError,
    selectedSession,
    sessionDetail,
    sessionDetailId,
    sessionDetailLoading,
    sessionDetailError,
    sessionWindow,
    query,
    setQuery,
    debouncedQuery,
    activeServerSearch,
    agentAddresses,
    defaultSessionEntry,
    primarySessionIds,
    pendingBySession,
    restorePending,
    renameSignal,
    loadSessions,
    loadSessionDetail,
    refreshSessions,
    retryLoad,
    showMore: () => setRenderLimit((value) => value + SESSION_PAGE_SIZE),
    handleRename,
    ...deleteApi,
  };
}
