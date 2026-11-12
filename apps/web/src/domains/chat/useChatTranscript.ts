import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { GatewayClient } from '../../gateway/client';
import type {
  AskUserRequest,
  Message,
  PermissionRequest,
  SessionDetail,
  SessionInfo,
} from '../../gateway/types';
import { t } from '../../i18n';
import { agentsForSession, findAgent, reduceAgents } from '../../state/agents';
import { readDisplayValue } from '../../state/display-settings';
import type { EventStoreSnapshot } from '../../state/event-store';
import type { RunGroup } from '../../state/events';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../../state/runtime-visibility';
import { resourceData, useResource } from '../../state/useResource';
import { resolveUiVisibility, showsInternalEvents } from '../../state/visibility';
import type { SessionDetailWindow, SessionLoadOptions } from '../../stores/sessionStore';
import {
  SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE,
  windowHasEarlier,
} from '../../stores/sessionStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { windowTail } from '../../transcript';
import { pendingForSession, pendingQueue } from './pending-permissions';
import type { QueuedSubmission } from './StreamItems';
import { browserSessionStorage, clearLastSession, readLastSession } from './session-selection';
import {
  buildHistoryIndex,
  type ClaimIdentity,
  ClaimLedger,
  claimRunFactsOf,
  sessionFailureOfDetail,
} from './transcript-items';

const TRANSCRIPT_WINDOW = 50;
/** 单会话实时组上限：超出时只渲染最近这些 run，并提供运行详情入口。 */
export const MAX_LIVE_GROUPS = 200;

export interface UseChatTranscriptOptions {
  client: GatewayClient;
  hasToken: boolean;
  epoch: number;
  selectedId: string | null;
  routeAgentId: string | undefined;
  snapshot: EventStoreSnapshot;
  runtimeVisibility: RuntimeVisibility;
  sessions: readonly SessionInfo[];
  sessionDetail: SessionDetail | null;
  sessionDetailId: string | null;
  /** `sessionDetail.messages` 的绝对窗口（CONTRACT-msg-system §4.3）。 */
  detailWindow: SessionDetailWindow | null;
  /** 历史前缀被改写的一次性提示（i18n key）；null = 无。 */
  detailNotice: string | null;
  dismissDetailNotice: () => void;
  /** 「加载更早」最近一次失败的原始细节；null = 无。 */
  earlierError: string | null;
  dismissEarlierError: () => void;
  /** 本地窗口耗尽后取 `next_before` 上一页并前插。 */
  loadEarlierDetail: (
    client: GatewayClient,
    id: string,
    options?: SessionLoadOptions,
  ) => Promise<void>;
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
  snapshot,
  runtimeVisibility,
  sessions,
  sessionDetail,
  sessionDetailId,
  detailWindow,
  detailNotice,
  dismissDetailNotice,
  earlierError,
  dismissEarlierError,
  loadEarlierDetail,
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
  // 卡片默认开合只在这里算一次（ui.expandCards || verbosity === 'debug'），
  // 沿 props 链传给 TranscriptWindow，避免每个子组件各自 useConfigStore。
  const cardsDefaultOpen =
    readDisplayValue(
      configState.status === 'success' ? configState.data : null,
      'ui.expandCards',
    ) === 'true' || visibility.verbosity === 'debug';

  // 时间线的输入源 = 物化后的 item 流（`LiveItemStore`），**不是** `snapshot.entries`。
  //
  // 事件到达时 `EventStore.push` 就已经把它折进 item store（唯一写入点），这里只是
  // 订阅它的 50ms 快照。于是缓冲裁剪 / `truncateAfter` / 回填都不会让屏上内容消失
  // （DESIGN.md I1 / I4 / I6）。
  // `snapshot.entries` 在本文件里只剩两个**传输面**消费者（标记逐处标明，见 tripwire）：
  // 成员树（`reduceAgents`）与终态刷新扫描（找 `run.completed` 等触发一次 detail 刷新）。
  const { eventStore } = useConnection();
  const itemStore = eventStore.items;
  const itemSnapshot = useSyncExternalStore(
    itemStore.subscribe,
    itemStore.getSnapshot,
    itemStore.getSnapshot,
  );
  const groups = itemSnapshot.groups;

  // 可见性口径交给物化面：`isVisibleForGrouping` 决定「哪些事件参与段边界」，
  // 所以它必须参与折叠而**不是**渲染时过滤；口径变化时 store 会按环里的全部事件重折叠
  // （唯一合法的整表重算，人工、低频）。这里用 effect 同步：初帧用默认档（隐藏内部事件 /
  // user），配置到达后一次重折叠就对上了。
  useEffect(() => {
    eventStore.setItemVisibility(showInternal, errorLevel);
  }, [eventStore, showInternal, errorLevel]);

  // 0.14：子 agent 树与 `?agent=` 深链（纯事件派生，不新增 RPC）。
  // transport-consumer：成员树读的是原始事件（不是时间线），见 DESIGN.md §11.9。
  const allAgents = useMemo(() => reduceAgents(snapshot.entries), [snapshot.entries]);
  const sessionAgents = useMemo(
    () => (selectedId ? agentsForSession(allAgents, selectedId) : []),
    [allAgents, selectedId],
  );
  const activeAgent =
    selectedId && routeAgentId ? findAgent(sessionAgents, routeAgentId) : undefined;

  // 上下文用量：**live 优先，落盘兜底**。
  //
  // 1. live：`agents.tree` 主 agent 的 `context_used` / `context_max`（运行中 5s 轮询，
  //    最新鲜）；
  // 2. 落盘：`sessions.get.context_usage`（服务端从该会话**事件日志尾窗**派生）。
  //    历史会话 / rotate 之后 / 进程重启之后 live 注册表是空的，只有这一份能回答
  //    「这个会话用了多少上下文」—— 用量是会话属性，不是身体属性；
  // 3. 两者都没有 → `undefined`（不伪造：`ComposerContextMeter` 在无数据时不渲染）。
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
  const liveContextData = resourceData(contextResource.state);
  // 只认属于当前选中会话的那一份（切会话时旧响应不能串到新会话）。
  const liveContextUsage =
    selectedId !== null && liveContextData != null && liveContextData.sessionId === selectedId
      ? liveContextData
      : undefined;
  // 落盘兜底同样只认当前选中会话的那一份（`sessionDetailId` 是 detail 的归属标记）。
  const persistedContextUsage =
    selectedId !== null && sessionDetailId === selectedId
      ? sessionDetail?.context_usage
      : undefined;
  const contextUsage = useMemo(() => {
    if (liveContextUsage) {
      const max = liveContextUsage.max ?? persistedContextUsage?.max;
      return { used: liveContextUsage.used, ...(max !== undefined ? { max } : {}) };
    }
    if (persistedContextUsage) {
      return {
        used: persistedContextUsage.used,
        ...(persistedContextUsage.max !== undefined ? { max: persistedContextUsage.max } : {}),
      };
    }
    return undefined;
  }, [liveContextUsage, persistedContextUsage]);

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
    if (readLastSession(storage) === selectedId) clearLastSession(storage);
  }, [hydrateError, selectedId]);

  // 只按会话归属过滤；「是否已落盘」不再由这里猜 —— 去重交给
  //  的认领（同一对象只出一个 item，见 transcript-items.ts）。
  const visibleGroups = useMemo(() => {
    if (!selectedId) return [];
    return groups.filter((group) => group.sessionId === selectedId);
  }, [groups, selectedId]);

  /**
   * 会话记录里的最近一次失败（`sessions.get` 的 `run_id` / `status` / `error` /
   * `completed_at`）。
   *
   * 为什么需要：历史消息不携带失败信息，事件缓冲有界（刷新 / 切会话 / 被淘汰后
   * `run.failed` 就不在回放窗口里了）。这些字段服务端早就在回，**不新增 RPC**。
   * 与事件流失败卡按 runId 去重（事件流优先），判定在 transcript-items.ts。
   */
  const sessionFailure = useMemo(() => sessionFailureOfDetail(sessionDetail), [sessionDetail]);

  const visibleQueued = useMemo(
    () => (selectedId ? queuedRuns.filter((item) => item.sessionId === selectedId) : []),
    [queuedRuns, selectedId],
  );
  // 单会话实时组上限：长会话只渲染最近 `MAX_LIVE_GROUPS` 个 run（更早的轮次仍可由历史 /
  // 运行详情查看）。这里**不再算** `hiddenLiveGroups`：以前算了却没有渲染入口 = 静默隐藏。
  // 真正的提示行需要新 i18n 文案与样式（本单不动 `i18n/**`），留给阶段 4；在那之前
  // 至少不留一个「算了不用」的假变量。
  const renderedGroups: readonly RunGroup[] =
    visibleGroups.length > MAX_LIVE_GROUPS ? visibleGroups.slice(-MAX_LIVE_GROUPS) : visibleGroups;

  // 0.18：停止入口固定在底部 Composer 区域，只对当前会话仍在跑的 run 出现。
  // `hasRunEvent` 排除成员事件聚合出的“永不终态”分组：它们的 runId 是成员 id，
  // 拿去 cancel 只会 not_found（F2）；没有 live run 时 Stop 也必须消失。
  const runningGroup = useMemo(
    () =>
      renderedGroups.find(
        (group) =>
          group.status === 'running' && group.hasRunEvent && !cancelledJobs.has(group.runId),
      ) ?? null,
    [renderedGroups, cancelledJobs],
  );
  const stopBusy = runningGroup ? cancelling.has(runningGroup.runId) : false;

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
    // transport-consumer：这里只找「该刷新 detail 了」的信号，不派生时间线。
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
  // 分页状态只认属于当前选中会话的那一份窗口（切走时旧响应不能串到新会话）。
  const selectedWindow =
    detailWindow !== null && detailWindow.sessionId === selectedId ? detailWindow : null;
  const windowNextBefore = selectedWindow?.next_before;
  // `keep_messages` / 撤回必须是完整 `state.messages` 的绝对下标：窗口首条消息的
  // 绝对下标 + 本地下标（CONTRACT-msg-system §4.3）。
  const messageIndexOffset = selectedWindow?.start ?? 0;
  // runtime 上下文（vessel:*）的可见性：与历史消息渲染共用同一判定。
  // 隐藏的消息仍进 index（绝对下标 / 认领 / previous-user 依赖它们），只是不产 item。
  // 只看结构化的 name（vessel:*）。**不按正文前缀猜**：用户可能自己粘一段以 [inbox] 开头的
  // 文本，按文本判定会把它当系统提示隐藏或渲成通知卡（吞用户输入）。
  const isHiddenMessage = useCallback(
    (message: Message): boolean => {
      const kind = runtimeMessageKind(message);
      return kind !== undefined && !isRuntimeMessageVisible(runtimeVisibility, kind);
    },
    [runtimeVisibility],
  );
  /** 这条消息在渲染层应作为哪种运行时提示卡（undefined = 普通消息）。 */
  const noticeKindOf = useCallback((message: Message): string | undefined => {
    return runtimeMessageKind(message);
  }, []);

  // 历史侧 item / 反查表按 messages 引用 memo：50ms 的流式节拍里不会重算。
  const historyIndex = useMemo(
    () => buildHistoryIndex(transcriptMessages, messageIndexOffset, isHiddenMessage, noticeKindOf),
    [transcriptMessages, messageIndexOffset, isHiddenMessage, noticeKindOf],
  );

  // 认领账本（DESIGN.md §4.2）：**一次性判定 + 单调粘住**，只在「历史窗口 / 连接纪元 /
  // 选中会话」变化，或出现**新 run / 新终态 / 首次拿到输入**时重判。
  //
  // 为什么必须粘住：live item 的生命周期变长了（不再随环裁剪消失）。若每帧按内容重算
  // 认领，live 正文一继续增长（或 guardrail 改写了正文）内容就不再相等 → 认领结论在两帧
  // 之间「让位 ↔ 不让位」抖动，屏上就会出现「两份 ↔ 一份」的闪现与重复。
  const ledgerRef = useRef<ClaimLedger | null>(null);
  ledgerRef.current ??= new ClaimLedger();
  const claimLedger = ledgerRef.current;
  // 事实取**整个会话**的 run（`visibleGroups`），不是只渲最近 200 轮的那一份
  // （`renderedGroups`）：交棒要能覆盖「已经滚出渲染窗口」的旧轮次，否则长会话里它们
  // 的 item 永远不会被释放，内存仍然随轮数增长（§8.1 的目的就落空了）。
  const claimFacts = useMemo(() => claimRunFactsOf(visibleGroups), [visibleGroups]);
  const claimIdentity = useMemo<ClaimIdentity>(
    () => ({
      sessionId: selectedId,
      epoch,
      ...(selectedWindow?.start !== undefined ? { windowStart: selectedWindow.start } : {}),
      ...(selectedWindow?.end !== undefined ? { windowEnd: selectedWindow.end } : {}),
      history: historyIndex,
    }),
    [selectedId, epoch, selectedWindow, historyIndex],
  );
  // 交棒的前置（DESIGN.md §4.3）：detail 必须是**当前选中会话的、非 stale 的**那一份。
  // 没有它，历史那份可能只是旧副本 —— 此时一件都不许交棒（屏上内容只能靠 live）。
  const detailReady =
    selectedId !== null &&
    sessionDetailId === selectedId &&
    sessionDetail !== null &&
    currentDetailError === null;
  const claims = claimLedger.decide(claimIdentity, {
    history: historyIndex,
    facts: claimFacts,
    detailReady,
    ...(sessionFailure !== undefined ? { failureRunId: sessionFailure.runId } : {}),
  });
  // 结论挂在历史索引上（`HistoryIndex.claims`）：`TranscriptWindow` 已经把这份索引传给
  // `buildTranscriptItems`，于是装配面不用改签名就吃到同一份结论（同一帧出最终列表）。
  const historyWithClaims = useMemo(
    () => (historyIndex.claims === claims ? historyIndex : { ...historyIndex, claims }),
    [historyIndex, claims],
  );
  // 交棒释放（DESIGN.md §8.1）：把这些「已有历史替身」的 item 移出 live 内存。
  //
  // 放在 post-commit effect 里（不在渲染中）：这一帧已经由历史那份渲染完，删掉的是
  // **重复的那一份**，屏幕零变化。删不删由账本证明（`handover` 只含有替身的段 / 卡）。
  const handover = claims.handover;
  useEffect(() => {
    if (!detailReady || handover.size === 0) return;
    itemStore.release(handover);
  }, [itemStore, handover, detailReady]);

  // 分页状态读取放 ref：`loadEarlier` 的身份必须稳定（TranscriptWindow 用它做
  // useLayoutEffect 依赖，新身份会让锚点回填 effect 每渲染都重跑）。
  const earlierStateRef = useRef({ localHidden: 0, nextBefore: undefined as string | undefined });
  earlierStateRef.current = { localHidden: transcriptStart, nextBefore: windowNextBefore };
  const loadEarlier = useCallback(() => {
    const { localHidden, nextBefore } = earlierStateRef.current;
    // 先扩本地可见窗口；耗尽后（本地下标已到 0）再拉服务端上一页。
    setTranscriptLimit((value) => value + TRANSCRIPT_WINDOW);
    if (localHidden > 0 || nextBefore === undefined || !selectedId) return;
    void loadEarlierDetail(client, selectedId, { epoch });
  }, [client, epoch, loadEarlierDetail, selectedId]);
  // 还有更早的分页没加载：本地窗口外还有可见消息，或服务端还有 `next_before`。
  const hasEarlier = transcriptStart > 0 || windowHasEarlier(selectedWindow);
  const hasTranscript = visibleTranscript.length > 0;

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
    sessionFailure,
    renderedGroups,
    visibleQueued,
    runningGroup,
    stopBusy,
    pendingItems,
    pendingItem,
    queueChips,
    pendingActive: pendingItems.length > 0,
    transcriptMessages,
    // 认领结论跟着历史索引一起下去（`HistoryIndex.claims`，见那里的说明）。
    historyIndex: historyWithClaims,
    /**
     * 认领失败计数（diagnostics 读这里，DESIGN.md §4.2-6）。
     *
     * 与 `eventStore.droppedNoise` 同一形态：只暴露只读计数、不进渲染（本单不动 UI）；
     * 它的用途是将来「重复的线上占比被量化到用户可感知」时给「位置认领要不要打开」取数。
     * 粘住期间（同一份历史窗口、没有新 run）这些计数不增长 —— 它记的是**判定**，不是帧。
     */
    claimStats: claimLedger.stats,
    isHiddenMessage,
    noticeKindOf,
    transcriptWindow,
    messageIndexOffset,
    cardsDefaultOpen,
    detailNotice,
    dismissDetailNotice,
    earlierError,
    dismissEarlierError,
    hasEarlier,
    hasTranscript,
    reloadDetail,
    loadEarlier,
  };
}
