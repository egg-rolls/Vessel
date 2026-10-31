import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayClient } from '../../gateway/client';
import type {
  AskUserRequest,
  PermissionRequest,
  SessionDetail,
  SessionInfo,
} from '../../gateway/types';
import { t } from '../../i18n';
import { agentsForSession, findAgent, reduceAgents } from '../../state/agents';
import type { EventStoreSnapshot } from '../../state/event-store';
import { isGroupPersisted, type RunGroup } from '../../state/events';
import { EventGroupCache } from '../../state/group-cache';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../../state/runtime-visibility';
import { resourceData, useResource } from '../../state/useResource';
import { resolveUiVisibility, showsInternalEvents } from '../../state/visibility';
import type { SessionLoadOptions } from '../../stores/sessionStore';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { windowTail } from '../../transcript';
import { pendingForSession, pendingQueue } from './pending-permissions';
import type { QueuedSubmission } from './StreamItems';
import { browserSessionStorage, clearLastSession, readLastSession } from './session-selection';

const TRANSCRIPT_WINDOW = 50;
/** 单会话实时组上限：超出时只渲染最近这些 run，并提供运行详情入口。 */
export const MAX_LIVE_GROUPS = 200;

export interface UseChatTranscriptOptions {
  client: GatewayClient;
  hasToken: boolean;
  epoch: number;
  selectedId: string | null;
  routeAgentId: string | undefined;
  tenantId: string | null;
  snapshot: EventStoreSnapshot;
  runtimeVisibility: RuntimeVisibility;
  sessions: readonly SessionInfo[];
  sessionDetail: SessionDetail | null;
  sessionDetailId: string | null;
  sessionDetailLoading: boolean;
  sessionDetailError: string | null;
  queuedRuns: readonly QueuedSubmission[];
  cancelling: ReadonlySet<string>;
  cancelledJobs: ReadonlySet<string>;
  pendingNewSessions: { current: Set<string> };
  loadSessionDetail: (
    client: GatewayClient,
    id: string,
    options?: SessionLoadOptions,
  ) => Promise<void>;
  refreshSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
}

/**
 * 实时会话内容：事件分组、子 agent、上下文用量、历史窗口、
 * 当前会话的权限 / ask 队列，以及终态事件后的精确刷新。
 */
export function useChatTranscript({
  client,
  hasToken,
  epoch,
  selectedId,
  routeAgentId,
  tenantId,
  snapshot,
  runtimeVisibility,
  sessions,
  sessionDetail,
  sessionDetailId,
  sessionDetailLoading,
  sessionDetailError,
  queuedRuns,
  cancelling,
  cancelledJobs,
  pendingNewSessions,
  loadSessionDetail,
  refreshSessions,
  permissions,
  asks,
}: UseChatTranscriptOptions) {
  const [transcriptLimit, setTranscriptLimit] = useState(TRANSCRIPT_WINDOW);

  // 切换会话重置历史窗口。
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId 变化是重置条件
  useEffect(() => {
    setTranscriptLimit(TRANSCRIPT_WINDOW);
  }, [selectedId]);

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
  const activeAgent =
    selectedId && routeAgentId ? findAgent(sessionAgents, routeAgentId) : undefined;

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
  const renderedGroups: readonly RunGroup[] =
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

  // 终态/session.saved 后做一次精确刷新（150ms 合并）。
  const refreshTimer = useRef<number | undefined>(undefined);
  const lastSnapshotVersion = useRef(0);
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

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingNewSessions 是 ref，.current 读取不进依赖
  const reloadDetail = useCallback(() => {
    if (!selectedId) return;
    void loadSessionDetail(client, selectedId, {
      epoch,
      force: true,
      allowMissing: pendingNewSessions.current.has(selectedId),
    });
  }, [client, epoch, loadSessionDetail, selectedId]);

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

  return {
    visibility,
    errorLevel,
    sessionAgents,
    activeAgent,
    contextUsage,
    hydrateError,
    hydrateStale,
    hydrating,
    visibleGroups,
    hiddenLiveGroups,
    renderedGroups,
    visibleQueued,
    runningGroup,
    stopBusy,
    pendingItems,
    pendingItem,
    queueChips,
    pendingActive: pendingItems.length > 0,
    transcriptMessages,
    transcriptWindow,
    transcriptStart,
    hasTranscript,
    truncated,
    reloadDetail,
    loadEarlier: () => setTranscriptLimit((value) => value + TRANSCRIPT_WINDOW),
  };
}
