import { useCallback, useEffect, useRef, useState } from 'react';
import { RAIL_MAX_WIDTH } from '../../app/layout';
import type { Route } from '../../app/router';
import { useDrawerA11y } from '../../app/useDrawerA11y';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { useViewportWidth } from '../../app/useViewportWidth';
import { useVisualViewport } from '../../app/useVisualViewport';
import { ResizeHandle } from '../../components/ResizeHandle';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import type { AskUserAnswer, PermissionScope } from '../../gateway/types';
import { t } from '../../i18n';
import { useRuntimeVisibility } from '../../state/runtime-visibility';
import { sessionTitle } from '../../state/sessions';
import { useAgentStore } from '../../stores/agentStore';
import { ChatHeader } from './ChatHeader';
import { ComposerSlot } from './ComposerSlot';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { SessionRail } from './SessionRail';
import { TranscriptWindow } from './TranscriptWindow';
import { useChatSessions } from './useChatSessions';
import { useChatSubmit } from './useChatSubmit';
import { useChatTranscript } from './useChatTranscript';

type ChatRoute = Extract<Route, { domain: 'chat' }>;

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
  const snapshot = useEventSnapshot();
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

  // 草稿态不再本地造 session id：首次发送由 `runs.start` 解析 main primary body。
  const pendingNewSessions = useRef(new Set<string>());
  const compact = useViewportWidth() <= RAIL_MAX_WIDTH;
  const [composerFocus, setComposerFocus] = useState(0);

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
    connectionState,
    epoch,
    tenantEpoch,
    tenantId,
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
    tenantId,
    snapshot,
    runtimeVisibility,
    sessions: sessionsApi.sessions,
    sessionDetail: sessionsApi.sessionDetail,
    sessionDetailId: sessionsApi.sessionDetailId,
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

  const runningGroup = transcriptApi.runningGroup;
  const stopHandler =
    connected && runningGroup ? () => void submitApi.handleCancel(runningGroup) : undefined;

  return (
    <div className="chat-workspace">
      <SessionRail
        sessions={sessionsApi.sessionWindow.shown}
        hiddenCount={sessionsApi.sessionWindow.hiddenCount}
        selectedId={selectedId}
        draftActive={draftActive}
        pendingBySession={sessionsApi.pendingBySession}
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
        onOpenConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
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
        {!panes.disabled('chat') && (
          <ResizeHandle
            pane="chat"
            api={panes}
            label={t('resize.chat')}
            className="resize-handle resize-handle-chat"
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

        <TranscriptWindow
          hasToken={hasToken}
          selectedId={selectedId}
          activeAgent={transcriptApi.activeAgent}
          draftActive={draftActive}
          restorePending={sessionsApi.restorePending}
          hydrateError={transcriptApi.hydrateError}
          hydrating={transcriptApi.hydrating}
          hydrateStale={transcriptApi.hydrateStale}
          truncated={transcriptApi.truncated}
          hasTranscript={transcriptApi.hasTranscript}
          visibleGroups={transcriptApi.visibleGroups}
          hiddenLiveGroups={transcriptApi.hiddenLiveGroups}
          renderedGroups={transcriptApi.renderedGroups}
          visibleQueued={transcriptApi.visibleQueued}
          transcriptWindow={transcriptApi.transcriptWindow}
          transcriptStart={transcriptApi.transcriptStart}
          transcriptMessages={transcriptApi.transcriptMessages}
          cancelledJobs={submitApi.cancelledJobs}
          verbosity={transcriptApi.visibility.verbosity}
          errorLevel={transcriptApi.errorLevel}
          entries={snapshot.entries}
          snapshotVersion={snapshot.version}
          detailSessionId={sessionsApi.sessionDetail?.session_id}
          onRetryDetail={transcriptApi.reloadDetail}
          onLoadEarlier={transcriptApi.loadEarlier}
          onCancelQueued={(runId) => void submitApi.handleCancelQueued(runId)}
          onConfigureConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
          onGoChat={() => navigate({ domain: 'chat' })}
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
          onOpenConnection={() => navigate({ domain: 'settings', tab: 'connection' })}
          focusSignal={composerFocus}
        />
      </section>

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
