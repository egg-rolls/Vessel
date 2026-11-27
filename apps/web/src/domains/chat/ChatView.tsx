import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { useViewportWidth } from '../../app/useViewportWidth';
import { useVisualViewport } from '../../app/useVisualViewport';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ResizeHandle } from '../../components/ResizeHandle';
import { useToast } from '../../components/ToastProvider';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import type { AskUserAnswer, PermissionScope } from '../../gateway/types';
import { t } from '../../i18n';
import { useRuntimeVisibility } from '../../state/runtime-visibility';
import { sessionTitle } from '../../state/sessions';
import { resourceData } from '../../state/useResource';
import { useAgentStore } from '../../stores/agentStore';
import { useAgentInboxRefreshTick } from '../inbox/agent-inbox-refresh';
import { useNodeNames } from '../nodes/useNodeNames';
import { useAskCursorPrune } from '../pending/ask-cursor-store';
import { useAskDraftPrune } from '../pending/ask-draft-store';
import { rosterAttributionIndex } from '../pending/attribution';
import { itemsForSession, pendingItems } from '../pending/cluster';
import { PluginPanels } from '../plugins/PluginPanels';
import { agentNamesOf } from './agent-labels';
import { AgentNamesProvider } from './agent-name-context';
import type { AnsweredAsk } from './ask-answered';
import { ChatHeader } from './ChatHeader';
import { ComposerSlot } from './ComposerSlot';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { errorMessage } from './errors';
import { sessionBodyOwners } from './main-session';
import { NodeNamesProvider } from './node-name-context';
import { PendingStrip } from './PendingStrip';
import type { PendingSend } from './pending-sends';
import { ProjectionReadbackProvider } from './projection-readback';
import { SessionRail } from './SessionRail';
import type { SessionRefScope } from './session-ref';
import { TranscriptWindow } from './TranscriptWindow';
import { ToolCatalogProvider } from './tool-catalog';
import { useAnsweredAsks } from './useAnsweredAsks';
import { useChatSessions } from './useChatSessions';
import { useChatSubmit } from './useChatSubmit';
import { useChatTranscript } from './useChatTranscript';
import { usePendingSends } from './usePendingSends';

type ChatRoute = Extract<Route, { domain: 'chat' }>;

/** 子 agent 详情态不给已答卡：空数组用固定引用，避免每帧换一个数组让时间线 memo 失效。 */
const EMPTY_ANSWERED_ASKS: readonly AnsweredAsk[] = [];

/** 子 agent 详情态不画本地待确认气泡：空数组用固定引用（与上一行同一个理由）。 */
const EMPTY_PENDING_SENDS: readonly PendingSend[] = [];

/**
 * 当前会话 body 的成员 id（工具描述目录 / inbox 面板按它拉 agent 级数据）。
 *
 * 派生链（inbox 统一批 §4.1，全部已有数据，不新增 RPC）：
 * 1. 显式选中的子 agent（`?agent=` 深链详情态）优先；
 * 2. 事件派生 agent 树（`agentsForSession` 的同一份数据）：取「`sessionId` 恰好是
 *    本会话」且深度最小的节点 —— 那正是拥有这具 body 的成员；
 * 3. roster 反查兜底（`sessionBodyOwners`）：历史会话 / 进程重启后事件树为空，
 *    但 roster 的 `session_id` / `bodies` / `body_history` 仍认得这具 body 归谁。
 * 都命中不了返回 `undefined`（不猜 id）：目录退回节点插件面，面板不发 RPC。
 */
function catalogAgentOfSession(
  activeAgentId: string | undefined,
  nodes: readonly { id: string; depth: number; sessionId?: string }[],
  sessionId: string | null,
  bodyOwners: ReadonlyMap<string, string>,
): string | undefined {
  if (activeAgentId !== undefined) return activeAgentId;
  if (sessionId === null) return undefined;
  const owners = nodes
    .filter((node) => node.sessionId === sessionId)
    .sort((a, b) => a.depth - b.depth);
  return owners[0]?.id ?? bodyOwners.get(sessionId);
}

/** 待确认的历史消息分支操作：keepMessages 是 `sessions.get` 的 session.messages 下标。 */
interface CreateTarget {
  kind: 'edit' | 'retry';
  sessionId: string;
  keepMessages: number;
  text: string;
}

/**
 * 聊天域容器：连接各域 hook 与子视图，负责路由导航与焦点交接。
 * 会话状态、实时内容、提交 / 排队分别见 useChatSessions / useChatTranscript /
 * useChatSubmit；渲染拆到 SessionRail / ChatHeader / TranscriptWindow / ComposerSlot。
 */
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
    features,
    permissions,
    asks,
    pendingFetch,
    hydrateInteractions,
    responding,
    respondPermission,
    respondAsk,
  } = useConnection();
  const snapshot = useEventSnapshot();
  const toast = useToast();
  const { visibility: runtimeVisibility } = useRuntimeVisibility();
  // 键盘弹出时把 visual viewport 尺寸写到根元素，供 dock 上限与外壳高度使用。
  useVisualViewport();
  const connected = connectionState === 'open' && hasToken;
  const durableFeature = features.includes('durable-resume');
  // 会话行的 agent 地址复用 Agents 域的 roster store，不新增 RPC 方法。
  const { nodes, teamControl } = useNodes();
  const loadRoster = useAgentStore((state) => state.loadRoster);

  const selectedId = route.sessionId && route.sessionId !== 'new' ? route.sessionId : null;
  const draftActive = route.sessionId === 'new';
  // 会话分区的「待批」计数：数「归到本会话」的 permission + ask（含成员 bridge 的父会话
  // 归属，历史脏数据靠 roster 上溯兑底）。注意它数的是「去待批页能看到几条」，与会话页
  // Composer 槽位「只渲自己 run 的请求」那条守卫不是同一个判据。
  const rosterState = useAgentStore((state) => state.roster);
  const attribution = useMemo(
    () => rosterAttributionIndex(resourceData(rosterState) ?? []),
    [rosterState],
  );
  // 工具卡摘要里的「谁」：同一份 roster 派生的标识→名字表（不新增任何轮询 / RPC）。
  // `send → <session id>` 这种卡头就在这里翻成人名（纯计算见 agent-labels.ts）。
  const agentNames = useMemo(() => agentNamesOf(resourceData(rosterState) ?? []), [rosterState]);
  // 节点展示名表（既有 useNodeNames：health 轮询 + sessionStorage 缓存，零新增请求）：
  // agent 工具卡的完整路由副行把 node 段换成节点名，查不到退原始 id。
  const nodeNames = useNodeNames();
  const sessionPendingCount = useMemo(
    () => itemsForSession(pendingItems(permissions, asks), selectedId, attribution).length,
    [permissions, asks, selectedId, attribution],
  );
  // ask 草稿的清理钩子：请求一旦从 pending 集合里消失（本端或别的端答的），
  // 它的草稿一起清 —— 否则这份 sessionStorage 副本会跟着标签页活到关掉为止。
  const pendingAskIds = useMemo(() => asks.map((item) => item.requestId), [asks]);
  useAskDraftPrune(pendingAskIds, connected);
  // 浏览位同理：请求消失后那条「上次停在第 3 题」也不该留着（还占 sessionStorage 配额）。
  useAskCursorPrune(pendingAskIds, connected);

  // 草稿态不再本地造 session id：首次发送由 `runs.start` 解析 main primary body。
  const pendingNewSessions = useRef(new Set<string>());
  const compact = useViewportWidth() <= RAIL_MAX_WIDTH;
  const [composerFocus, setComposerFocus] = useState(0);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [creating, setCreating] = useState(false);

  const drawerRef = useDrawerA11y({
    open: sessionsOpen,
    onClose: onCloseSessions,
    enabled: compact,
    returnFocusId: 'sessions-toggle',
  });

  // 进入草稿态时把焦点交给输入框；会话 id 由服务端在首次发送后回填。
  useEffect(() => {
    if (draftActive) setComposerFocus((value) => value + 1);
  }, [draftActive]);

  // 选中会话 / 重连后从服务端补回 pending 交互（浏览器刷新不会重放旧 WS 事件）。
  // ConnectionProvider 的 [epoch, hasToken] effect 负责连接 / 刷新，这里补“切会话”。
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是重连后的显式刷新触发器
  useEffect(() => {
    if (!selectedId || !connected) return;
    void hydrateInteractions();
  }, [selectedId, connected, epoch, hydrateInteractions]);

  const sessionsApi = useChatSessions({
    client,
    hasToken,
    epoch,
    selectedId,
    routeSessionId: route.sessionId,
    durableFeature,
    connected,
    navigate,
    permissions,
    asks,
    nodes,
    teamControl,
    loadRoster,
    pendingNewSessions,
  });

  const submitApi = useChatSubmit({
    client,
    connected,
    selectedId,
    epoch,
    navigate,
    loadSessions: sessionsApi.loadSessions,
    loadRoster,
    nodes,
    teamControl,
    pendingNewSessions,
  });

  // 会话引用 chip 的渐进披露基准：当前会话的节点 / 团队（与卡片第二行地址同一份
  // roster 派生，不新增请求）。草稿态（无选中会话）= 当前节点、无团队 —— 新 agent
  // 将落在本节点且不入任何 team，跨队 / 跨节点的引用照常显徽章。
  const composerScope = useMemo<SessionRefScope>(() => {
    const agent = sessionsApi.selectedSession?.agent;
    const address = agent ? sessionsApi.agentAddressesById.get(agent.id) : undefined;
    if (address) {
      return { node: address.node, ...(address.team ? { team: address.team } : {}) };
    }
    const rosters = resourceData(rosterState) ?? [];
    const current = rosters.find((roster) => roster.node.current) ?? rosters[0];
    const node = current?.node.name;
    return node ? { node } : {};
  }, [sessionsApi.selectedSession, sessionsApi.agentAddressesById, rosterState]);

  const transcriptApi = useChatTranscript({
    client,
    hasToken,
    epoch,
    selectedId,
    routeAgentId: route.agent,
    snapshot,
    runtimeVisibility,
    sessions: sessionsApi.sessions,
    sessionDetail: sessionsApi.sessionDetail,
    sessionDetailId: sessionsApi.sessionDetailId,
    detailWindow: sessionsApi.detailWindow,
    detailNotice: sessionsApi.detailNotice,
    dismissDetailNotice: sessionsApi.dismissDetailNotice,
    earlierError: sessionsApi.earlierError,
    dismissEarlierError: sessionsApi.dismissEarlierError,
    loadEarlierDetail: sessionsApi.loadEarlierDetail,
    sessionDetailLoading: sessionsApi.sessionDetailLoading,
    sessionDetailError: sessionsApi.sessionDetailError,
    cancelling: submitApi.cancelling,
    cancelledJobs: submitApi.cancelledJobs,
    pendingNewSessions,
    loadSessionDetail: sessionsApi.loadSessionDetail,
    refreshSessions: sessionsApi.refreshSessions,
    permissions,
    asks,
  });

  // 0.56 乐观渲染：本地待确认的灰气泡。数据源是**事件流**（`snapshot.entries`，与
  // `LiveItemStore` 同一条），回显一到就撤；没回显且调度器对该会话已无在飞工作时转失败态
  // （重试 / 删除）—— agent 还在跑就不判超时（用户裁决，见 `pending-sends.ts#sweep`）。
  // 它只消费 `run_id` / `session_id`，不碰 transcript 的消息身份（见 pending-sends.ts）。
  // 子 agent 详情页不画（那一屏讲的是另一个 run，与失败卡 / 已答卡同一个口径），
  // 但照常吃事件 —— 摘除动作与画不画无关，停掉反而会让 pending 卡在屏上等超时。
  // 在飞集合来自 `health.get.runtime.scheduler`（权威账本，NodeProvider 已在轮询，零新增请求）。
  const busySessions = useMemo(
    () => new Set(sessionsApi.sessionInflight.keys()),
    [sessionsApi.sessionInflight],
  );
  const pendingSendsApi = usePendingSends({
    entries: snapshot.entries,
    sessionId: selectedId,
    busySessions,
    onRetry: (pending) => {
      void submitApi.handleRetryPending(pending);
    },
  });

  // 已答提问的取数：数据来自服务端 answered 记录（落盘的真相），刷新 / 重连靠它重建。
  // 子 agent 详情态不读（那一屏讲的是另一个 run），草稿态没有会话 id 也不读。
  const answeredAsks = useAnsweredAsks({
    sessionId: transcriptApi.activeAgent ? null : selectedId,
    client,
    epoch,
    connected,
    refreshKey: submitApi.sendTick + transcriptApi.visibleGroups.length + asks.length,
  });

  // 槽位从待处理切回输入框时把焦点还给 Composer。
  const pendingWasActive = useRef(false);
  useEffect(() => {
    if (pendingWasActive.current && !transcriptApi.pendingActive) {
      setComposerFocus((value) => value + 1);
    }
    pendingWasActive.current = transcriptApi.pendingActive;
  }, [transcriptApi.pendingActive]);

  /**
   * 「收回编辑」的落点：把待处理条带 peek 到的**全文**放回本会话的草稿槽。
   *
   * 草稿的持有者是 `useChatSubmit`（`chatDraftKey` 的草稿 store），所以条带只认这一条
   * 回调，不自己去碰 store。三条约束：
   * - **只写草稿，不发送**：`setInputForSession` 只碰草稿 store；发送只发生在 Composer 的
   *   Enter / 发送键里（这条链路上没有任何 `handleSend`）；
   * - **不覆盖人已经写着的字**：槽非空时接在后面（换行分隔）。覆盖等于「收回一条排队、
   *   顺手吞掉一段草稿」，那是静默的数据损失；
   * - 焦点交给输入框（与新建会话 / edit 回填同一条 `composerFocus` 通道），收回就能改。
   */
  const refillDraftFromStrip = useCallback(
    (text: string) => {
      if (!selectedId) return;
      submitApi.setInputForSession(selectedId, (current) =>
        current.trim().length === 0 ? text : `${current}\n${text}`,
      );
      setComposerFocus((value) => value + 1);
    },
    [selectedId, submitApi.setInputForSession],
  );

  const selectSession = (sessionId: string) => {
    navigate({ domain: 'chat', sessionId });
    onCloseSessions();
  };

  const startNewSession = () => {
    navigate({ domain: 'chat', sessionId: 'new' });
    onCloseSessions();
  };

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

  const targetLabel = selectedId
    ? t('chat.target.session', {
        title: sessionsApi.selectedSession ? sessionTitle(sessionsApi.selectedSession) : selectedId,
      })
    : t('chat.target.new');

  const runningGroup = transcriptApi.runningGroup;
  const stopHandler =
    connected && runningGroup ? () => void submitApi.handleCancel(runningGroup) : undefined;

  // 编辑 / 重试不再截断历史：先确认，确认后从源 session 前缀创建新 session
  // （`sessions.create{from_session_id, keep_messages}`），源 session 保留只读。
  const openCreate = (kind: CreateTarget['kind'], keepMessages: number, text: string) => {
    if (!selectedId) return;
    setCreateTarget({ kind, sessionId: selectedId, keepMessages, text });
  };
  const handleEditMessage = (keepMessages: number, text: string) => {
    openCreate('edit', keepMessages, text);
  };
  const handleRetryMessage = (keepMessages: number, text: string) => {
    openCreate('retry', keepMessages, text);
  };

  /**
   * `sessions.create{from_session_id}` 要求源 session 是当前 primary。
   * 查看历史会话时先 `sessions.activate` 把它恢复为 primary；roster 没给 primary
   * 集合（旧 gateway）时跳过，交给服务端返回 conflict。
   */
  const activateSourceIfRetained = async (sessionId: string) => {
    const primaries = sessionsApi.primarySessionIds;
    if (primaries.size === 0 || primaries.has(sessionId)) return;
    await client.activateSession({ session_id: sessionId });
  };

  const handleConfirmCreate = async () => {
    const target = createTarget;
    if (!target || creating) return;
    // 确认框打开期间切换了会话：不把旧下标发到新会话。
    if (target.sessionId !== selectedId) {
      setCreateTarget(null);
      return;
    }
    setCreating(true);
    let nextSessionId: string;
    try {
      await activateSourceIfRetained(target.sessionId);
      const created = await client.createSession({
        from_session_id: target.sessionId,
        keep_messages: target.keepMessages,
      });
      nextSessionId = created.session_id;
      // 新 session 已成为 primary；列表需要刷新才能显示它。
      void sessionsApi.loadSessions(client, { epoch, force: true });
    } catch (error) {
      toast.error(errorMessage(error));
      setCreating(false);
      return;
    }
    // 源 session 保留（只读）：切到新 session 后回填 / 重发。
    setCreateTarget(null);
    setCreating(false);
    navigate({ domain: 'chat', sessionId: nextSessionId });
    // 目标会话的槽要显式指定：此时 `selectedId` 还是源会话（`hashchange` 未到）。
    submitApi.setInputForSession(nextSessionId, target.text);
    if (target.kind === 'edit') {
      setComposerFocus((value) => value + 1);
      toast.success(t('chat.message.create.editDone'));
    } else {
      // 先回填再重发：重发失败时原文仍留在输入框。
      await submitApi.handleRetry(target.text, nextSessionId);
    }
  };

  // 工具描述目录 / inbox 面板：知道属于哪个成员就按成员拉（`inbox` 这类成员内置工具才有描述）。
  // roster 反查表与 attribution 同源（同一份 rosterState，不新增轮询 / RPC）。
  const bodyOwners = useMemo(
    () => sessionBodyOwners(resourceData(rosterState) ?? []),
    [rosterState],
  );
  const catalogAgentId = catalogAgentOfSession(
    transcriptApi.activeAgent?.id,
    transcriptApi.sessionAgents,
    selectedId,
    bodyOwners,
  );

  // inbox 变更的 live 触发器（agent 级，与取数同口径 I-1）：该 agent 的条目被
  // `inbox read/delete` 消费、或新条目入队（含跨会话 / wake-quiet 投递）时，条带立刻
  // 重读一次（不等 2s 兜底轮询，更不等页面刷新）。数据源仍是那次 RPC，事件只当触发器
  // （判据见 ../inbox/agent-inbox-refresh.ts；会话级 useInboxRefresh 已退役删除）。
  // 工具帧归属用的 body sessions 由 roster 反查表反转而来（同一份数据，不新增 RPC）。
  const agentSessions = useMemo(() => {
    const sessions = new Set<string>();
    if (catalogAgentId === undefined) return sessions;
    for (const [session, agent] of bodyOwners) {
      if (agent === catalogAgentId) sessions.add(session);
    }
    return sessions;
  }, [bodyOwners, catalogAgentId]);
  const inboxRefreshTick = useAgentInboxRefreshTick(
    snapshot.entries,
    catalogAgentId,
    agentSessions,
  );

  return (
    <ToolCatalogProvider
      client={client}
      enabled={connected}
      epoch={epoch}
      {...(catalogAgentId !== undefined ? { agentId: catalogAgentId } : {})}
    >
      <div className="chat-workspace">
        <SessionRail
          sessions={sessionsApi.sessionWindow.shown}
          hiddenCount={sessionsApi.sessionWindow.hiddenCount}
          listReset={`${epoch}:${sessionsApi.renderLimit}:${sessionsApi.query}`}
          selectedId={selectedId}
          draftActive={draftActive}
          pendingBySession={sessionsApi.pendingBySession}
          inflightBySession={sessionsApi.sessionInflight}
          pendingAskCount={sessionPendingCount}
          onOpenPending={() =>
            navigate({ domain: 'pending', ...(selectedId ? { sessionId: selectedId } : {}) })
          }
          agentAddresses={sessionsApi.agentAddresses}
          agentAddressesById={sessionsApi.agentAddressesById}
          agentDepths={sessionsApi.agentDepths}
          agentLabels={sessionsApi.agentLabels}
          agentRetiredLabels={sessionsApi.agentRetiredLabels}
          defaultSession={sessionsApi.defaultSessionEntry}
          primarySessionIds={sessionsApi.primarySessionIds}
          query={sessionsApi.query}
          onQueryChange={sessionsApi.setQuery}
          searchSnippets={sessionsApi.activeServerSearch?.snippets}
          loading={sessionsApi.sessionsLoading}
          error={sessionsApi.sessionsError}
          onRetry={sessionsApi.retryLoad}
          hasToken={hasToken}
          onSelect={selectSession}
          onNew={startNewSession}
          onRename={sessionsApi.handleRename}
          onDelete={sessionsApi.openDelete}
          onViewRuns={(sessionId) => navigate({ domain: 'runs', tab: 'live', sessionId })}
          onShowMore={sessionsApi.showMore}
          compact={compact}
          onCloseDrawer={onCloseSessions}
          onOpenConnection={() => navigate({ domain: 'gateway' })}
          writesDisabled={!connected}
          renameSignal={sessionsApi.renameSignal}
          sessionsOpen={sessionsOpen}
          drawerRef={drawerRef}
          panes={panes}
        />

        <section
          className="conversation"
          aria-label={t('chat.main.conversationLabel')}
          inert={compact && sessionsOpen ? true : undefined}
        >
          <h1 className="sr-only">{t('chat.main.heading')}</h1>

          {/* 手柄与页头 / 转录区同属 content-stage：纵范围到转录区底部为止，
            不再纵跨整列压到输入区上（拖输入框右缘不会再被手柄抢走）。 */}
          <div className="content-stage">
            {!panes.disabled('chat') && (
              <ResizeHandle
                pane="chat"
                api={panes}
                label={t('resize.chat')}
                className="resize-handle resize-handle-content"
              />
            )}

            <ChatHeader
              selectedId={selectedId}
              selectedSession={sessionsApi.selectedSession}
              sessionDetail={sessionsApi.sessionDetail}
              agents={transcriptApi.sessionAgents}
              activeAgentId={transcriptApi.activeAgent?.id}
              draftActive={draftActive}
              onSelectAgent={(agentId) => {
                if (!selectedId) return;
                navigate({
                  domain: 'chat',
                  sessionId: selectedId,
                  ...(agentId ? { agent: agentId } : {}),
                });
              }}
            />

            {selectedId && (
              <PluginPanels
                slot="session-detail"
                context={{ session: selectedId }}
                className="flex-none px-4 pb-2"
              />
            )}

            {/* 投影卡的「读回完整原文」（0.54）只影响时间线里的工具卡，所以只包住转录区：
              `sessions.events` 按 `tool_call_id` 找那条工具结果。sessionId 用这份消息属于哪个
              会话（detail 到了以它为准，切会话的中途不会去读隔壁会话的日志）。 */}
            {/* 工具卡摘要的名字表（roster 派生）：`agent` / `inbox` 卡头不再直接回显内部 id。
              范围与上面那条同一个理由 —— 只有转录区里的工具卡读它；没有 roster 时是空表，
              卡片一律退短 id，不编名字。 */}
            <AgentNamesProvider names={agentNames}>
              {/* 节点展示名表（问题2）：agent 工具卡的路由副行 / 展开体把 node 段换成
                  节点名。与 agent 名字表同一个注入理由 —— 卡片不拉连接模块进渲染树。 */}
              <NodeNamesProvider names={nodeNames}>
                <ProjectionReadbackProvider
                  client={client}
                  sessionId={sessionsApi.sessionDetail?.session_id ?? selectedId ?? undefined}
                >
                  <TranscriptWindow
                    hasToken={hasToken}
                    selectedId={selectedId}
                    activeAgent={transcriptApi.activeAgent}
                    draftActive={draftActive}
                    restorePending={sessionsApi.restorePending}
                    hydrateError={transcriptApi.hydrateError}
                    hydrating={transcriptApi.hydrating}
                    hydrateStale={transcriptApi.hydrateStale}
                    hasTranscript={transcriptApi.hasTranscript}
                    hasEarlier={transcriptApi.hasEarlier}
                    visibleGroups={transcriptApi.visibleGroups}
                    renderedGroups={transcriptApi.renderedGroups}
                    transcriptWindow={transcriptApi.transcriptWindow}
                    transcriptMessages={transcriptApi.transcriptMessages}
                    historyIndex={transcriptApi.historyIndex}
                    isHiddenMessage={transcriptApi.isHiddenMessage}
                    noticeKindOf={transcriptApi.noticeKindOf}
                    messageIndexOffset={transcriptApi.messageIndexOffset}
                    sessionFailure={transcriptApi.sessionFailure}
                    sessionSystemContext={transcriptApi.sessionSystemContext}
                    projectionSummary={sessionsApi.sessionDetail?.projection_summary}
                    detailNotice={transcriptApi.detailNotice}
                    onDismissDetailNotice={transcriptApi.dismissDetailNotice}
                    earlierError={transcriptApi.earlierError}
                    onDismissEarlierError={transcriptApi.dismissEarlierError}
                    onRetryEarlier={() => {
                      // 重试只重取「上一页」：服务端游标由窗口首条决定，失败后窗口没动，
                      // 因此直接重发同一个 before 请求（不经本地扩窗，避免白扩一页）。
                      if (!selectedId) return;
                      void sessionsApi.loadEarlierDetail(client, selectedId, { epoch });
                    }}
                    verbosity={transcriptApi.visibility.verbosity}
                    cardsDefaultOpen={transcriptApi.cardsDefaultOpen}
                    errorLevel={transcriptApi.errorLevel}
                    entries={snapshot.entries}
                    snapshotVersion={snapshot.version}
                    detailSessionId={sessionsApi.sessionDetail?.session_id}
                    sendTick={submitApi.sendTick}
                    onRetryDetail={transcriptApi.reloadDetail}
                    onLoadEarlier={transcriptApi.loadEarlier}
                    onConfigureConnection={() => navigate({ domain: 'gateway' })}
                    onGoChat={() => navigate({ domain: 'chat' })}
                    onEditMessage={handleEditMessage}
                    onRetryMessage={handleRetryMessage}
                    // 已答提问：服务端 answered 记录按 answered_at 落进时间线（item kind
                    // ask-answered），不再是滚动区末尾的额外一段。子 agent 详情页讲的是另一个
                    // run，那里不画（TranscriptWindow 按 activeAgent 自己断，同失败卡的口径）。
                    answeredAsks={transcriptApi.activeAgent ? EMPTY_ANSWERED_ASKS : answeredAsks}
                    // 0.56 乐观渲染：本地待确认的灰气泡（点击那一帧就在屏上）。
                    // 子 agent 详情页不画（那一屏讲的是另一个 run），数据仍照常订阅。
                    pendingSends={
                      transcriptApi.activeAgent ? EMPTY_PENDING_SENDS : pendingSendsApi.pending
                    }
                    onRetryPending={pendingSendsApi.retry}
                    onDismissPending={pendingSendsApi.dismiss}
                  />
                </ProjectionReadbackProvider>
              </NodeNamesProvider>
            </AgentNamesProvider>

            {/* 待处理条带与转录区**同一个容器**（`.content-stage`），但不在滚动区里：
              条带只负责「还有几条在等」，跟着输入区一起常驻。宽度 / 内边距由它自己
              对齐消息列（见 PendingStrip.tsx）。数据源是服务端持久真相
              （`agents.inbox{ agent_id }`，agent 级全量，I-1），刷新 / 切会话都不丢；
              `refreshKey` 只是「再读一次盘」的触发器（本会话新受理一次发送 / run 数变化 /
              inbox 变更 live 事件：`inbox read/delete` 消费、新条目入队，**agent 级**判据，
              含跨会话 / wake-quiet 投递；面板展开重读在条带内部，D-5）。 */}
            <PendingStrip
              sessionId={selectedId}
              agentId={catalogAgentId}
              client={client}
              epoch={epoch}
              refreshKey={
                submitApi.sendTick + transcriptApi.visibleGroups.length + inboxRefreshTick
              }
              pendings={transcriptApi.activeAgent ? EMPTY_PENDING_SENDS : pendingSendsApi.pending}
              sentMessageIds={pendingSendsApi.sentMessageIds}
              onRefillDraft={refillDraftFromStrip}
              onRetryPending={(pending) => {
                void submitApi.handleRetryPending(pending);
              }}
              // 「编辑」= 内容回输入框 + 条带那条消失（两步都在这里落地：草稿槽在
              // `useChatSubmit`，store 在 `usePendingSends`）。条带已经先把服务端那份撤掉
              // 了（见 PendingStrip.tsx 的 editRow），所以这里不会再冒出第二条一样的消息。
              onEditPending={(pending) => {
                refillDraftFromStrip(pending.text);
                pendingSendsApi.dismiss(pending);
              }}
              onDismissPending={pendingSendsApi.dismiss}
              // 真相源对账（P0-A）：每次读盘后用服务端 entries 收口客户端 pending ——
              // `inbox read` 消费排队消息没有回显，不对账那行「等待中」会常驻到刷新。
              onReconcile={pendingSendsApi.reconcile}
              // 兜底认领升级：queued 事件缺席时 pending 靠摘要认领服务端条目，读到
              // 真实条目后升级成精确 id，对账与写操作才都有强身份可用。
              onAttachMessage={pendingSendsApi.attachMessage}
            />
          </div>

          <ComposerSlot
            pendingItem={transcriptApi.pendingItem}
            pendingItems={transcriptApi.pendingItems}
            queueChips={transcriptApi.queueChips}
            responding={responding}
            connected={connected}
            onStop={stopHandler}
            stopping={transcriptApi.stopBusy}
            onDecide={handleDecidePermission}
            onRespondAsk={handleRespondAsk}
            value={submitApi.input}
            onChange={submitApi.setInput}
            onSubmit={() => void submitApi.handleSend()}
            submitting={submitApi.submitting}
            targetLabel={targetLabel}
            hasToken={hasToken}
            onOpenConnection={() => navigate({ domain: 'gateway' })}
            focusSignal={composerFocus}
            refs={submitApi.refs}
            onRemoveRef={submitApi.removeRef}
            onAddRef={submitApi.addRef}
            client={client}
            contextUsage={transcriptApi.contextUsage}
            memberModel={
              // 成员模型切换入口（model-registry P2）：会话带归属成员才显示；
              // 当前模型读 system_context.model（这具 body 最后看到的），不是 pin。
              sessionsApi.selectedSession?.agent
                ? {
                    agentId: sessionsApi.selectedSession.agent.id,
                    agentName: sessionsApi.selectedSession.agent.name,
                    currentModel: sessionsApi.sessionDetail?.system_context?.model,
                  }
                : undefined
            }
            pendingFetch={pendingFetch}
            onRetryPendingFetch={() => {
              void hydrateInteractions();
            }}
            sessionRefs={submitApi.sessionRefs}
            onRemoveSessionRef={submitApi.removeSessionRef}
            onAddSessionRef={submitApi.addSessionRef}
            currentScope={composerScope}
            sessionId={selectedId ?? undefined}
          />
        </section>

        {createTarget && (
          <ConfirmDialog
            title={
              createTarget.kind === 'edit'
                ? t('chat.message.create.editTitle')
                : t('chat.message.create.retryTitle')
            }
            body={
              createTarget.kind === 'edit'
                ? t('chat.message.create.editBody')
                : t('chat.message.create.retryBody')
            }
            confirmLabel={t('chat.message.create.confirm')}
            busy={creating}
            onConfirm={() => void handleConfirmCreate()}
            onCancel={() => {
              if (!creating) setCreateTarget(null);
            }}
          />
        )}

        {sessionsApi.deleteTarget && (
          <DeleteSessionDialog
            target={sessionsApi.deleteTarget}
            counts={sessionsApi.deleteCounts}
            error={sessionsApi.deleteError}
            connected={connected}
            busy={sessionsApi.deleteBusy}
            onConfirm={() => void sessionsApi.handleDelete()}
            onCancel={sessionsApi.closeDelete}
            onViewRuns={() => {
              const target = sessionsApi.deleteTarget;
              if (!target) return;
              sessionsApi.closeDelete();
              navigate({ domain: 'runs', tab: 'durable', sessionId: target.session_id });
            }}
          />
        )}
      </div>
    </ToolCatalogProvider>
  );
}
