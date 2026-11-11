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
import { useAgentStore } from '../../stores/agentStore';
import { asksForSession } from '../pending/cluster';
import { PluginPanels } from '../plugins/PluginPanels';
import { ChatHeader } from './ChatHeader';
import { ComposerSlot } from './ComposerSlot';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { errorMessage } from './errors';
import { PendingStrip } from './PendingStrip';
import { SessionRail } from './SessionRail';
import { TranscriptWindow } from './TranscriptWindow';
import { useChatSessions } from './useChatSessions';
import { useChatSubmit } from './useChatSubmit';
import { useChatTranscript } from './useChatTranscript';

type ChatRoute = Extract<Route, { domain: 'chat' }>;

/** 待确认的历史消息分支操作：keepMessages 是 `sessions.get` 的 session.messages 下标。 */
interface CreateTarget {
  kind: 'edit' | 'retry';
  sessionId: string;
  keepMessages: number;
  text: string;
}

/**
 * 会让「待处理条带」重取的事件：收件箱投递（`agent.message.*`）与 `run.started`。
 * 投递只有一条事件（`agent.message.queued` + `delivery`）；`agent.message.notified` 是
 * 合并前的旧名，留着只为历史日志的计数口径不变。
 */
const STRIP_REFRESH_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.message.queued',
  'agent.message.notified',
  'agent.message.sent',
  'run.started',
]);

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
  // 会话分区的「待批」计数：只数本会话（含成员 bridge 的父会话归属）的 ask_user。
  const sessionAskCount = useMemo(
    () => asksForSession(asks, selectedId).length,
    [asks, selectedId],
  );

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
    snapshot,
    loadSessions: sessionsApi.loadSessions,
    loadRoster,
    nodes,
    teamControl,
    pendingNewSessions,
  });

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
    queuedRuns: submitApi.queuedRuns,
    cancelling: submitApi.cancelling,
    cancelledJobs: submitApi.cancelledJobs,
    pendingNewSessions,
    loadSessionDetail: sessionsApi.loadSessionDetail,
    refreshSessions: sessionsApi.refreshSessions,
    permissions,
    asks,
  });

  // 槽位从待处理切回输入框时把焦点还给 Composer。
  const pendingWasActive = useRef(false);
  useEffect(() => {
    if (pendingWasActive.current && !transcriptApi.pendingActive) {
      setComposerFocus((value) => value + 1);
    }
    pendingWasActive.current = transcriptApi.pendingActive;
  }, [transcriptApi.pendingActive]);

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

  // 待处理条带按 agent 维度取 inbox：用会话里最小的 depth 节点（与上下文用量同口径）。
  const stripAgentId = useMemo(() => {
    if (!selectedId) return null;
    const nodes = transcriptApi.sessionAgents;
    const main = [...nodes].sort((a, b) => a.depth - b.depth)[0];
    return main?.id ?? selectedId;
  }, [selectedId, transcriptApi.sessionAgents]);

  // 事件驱动失效：agent.message.* / run.started 出现次数变化时重取（不加轮询）。
  // 一次投递现在只落一条 `agent.message.queued`（旧日志里的 `agent.message.notified`
  // 仍计入，历史会话的计数不会因为少一类行而漂移）。
  const stripRefreshKey = useMemo(
    () =>
      snapshot.entries.reduce(
        (count, entry) => (STRIP_REFRESH_EVENT_TYPES.has(entry.event.type) ? count + 1 : count),
        0,
      ),
    [snapshot.entries],
  );

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

  return (
    <div className="chat-workspace">
      <SessionRail
        sessions={sessionsApi.sessionWindow.shown}
        hiddenCount={sessionsApi.sessionWindow.hiddenCount}
        selectedId={selectedId}
        draftActive={draftActive}
        pendingBySession={sessionsApi.pendingBySession}
        pendingAskCount={sessionAskCount}
        onOpenPending={() =>
          navigate({ domain: 'pending', ...(selectedId ? { sessionId: selectedId } : {}) })
        }
        agentAddresses={sessionsApi.agentAddresses}
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
            contextUsage={transcriptApi.contextUsage}
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
            visibleQueued={transcriptApi.visibleQueued}
            transcriptWindow={transcriptApi.transcriptWindow}
            transcriptMessages={transcriptApi.transcriptMessages}
            historyIndex={transcriptApi.historyIndex}
            isHiddenMessage={transcriptApi.isHiddenMessage}
            noticeKindOf={transcriptApi.noticeKindOf}
            messageIndexOffset={transcriptApi.messageIndexOffset}
            sessionFailure={transcriptApi.sessionFailure}
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
            onCancelQueued={(runId) => void submitApi.handleCancelQueued(runId)}
            onConfigureConnection={() => navigate({ domain: 'gateway' })}
            onGoChat={() => navigate({ domain: 'chat' })}
            onEditMessage={handleEditMessage}
            onRetryMessage={handleRetryMessage}
          />
        </div>

        <PendingStrip
          client={client}
          agentId={stripAgentId}
          enabled={connected && selectedId !== null}
          refreshKey={stripRefreshKey}
        />

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
  );
}
