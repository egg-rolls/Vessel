import { memo, type RefObject } from 'react';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { ResizeHandle } from '../../components/ResizeHandle';
import type { SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { SessionList } from './SessionList';

/**
 * 左侧会话栏：列表 + 分栏拖拽 + compact 抽屉遮罩。
 * 纯展示；查询、选中、重命名、删除等动作由 ChatView 注入。
 *
 * **memo**（st-F1 拆订阅）：流式期 ChatView 每 50ms 重渲染，但会话栏的 props
 * （会话窗口 / 徽标表 / 稳定回调）几乎从不变 —— 整棵跳过，20Hz 节拍不再波及会话列表。
 */
export const SessionRail = memo(function SessionRail({
  sessions,
  hiddenCount,
  selectedId,
  draftActive,
  pendingBySession,
  inflightBySession,
  pendingAskCount,
  onOpenPending,
  agentAddresses,
  agentAddressesById,
  agentDepths,
  agentLabels,
  agentRetiredLabels,
  defaultSession,
  primarySessionIds,
  query,
  onQueryChange,
  searchSnippets,
  loading,
  error,
  onRetry,
  hasToken,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onViewRuns,
  onShowMore,
  compact,
  onCloseDrawer,
  onOpenConnection,
  writesDisabled,
  renameSignal,
  sessionsOpen,
  drawerRef,
  panes,
}: {
  sessions: readonly SessionInfo[];
  hiddenCount: number;
  selectedId: string | null;
  draftActive: boolean;
  pendingBySession: ReadonlyMap<string, number>;
  /** 0.56：权威在飞状态（只画徽标，不参与排序）。 */
  inflightBySession?: ReadonlyMap<string, 'running' | 'queued'>;
  /** 当前会话待回答的 ask 条数；0 时不渲染「待批」入口。 */
  pendingAskCount?: number;
  onOpenPending?: () => void;
  agentAddresses: ReadonlyMap<string, string>;
  agentAddressesById: ReadonlyMap<string, { node: string; team?: string }>;
  /** 会话 → 树深度（depth-color D1：roster 反查档；主路径是 session.agent.depth）。 */
  agentDepths: ReadonlyMap<string, number>;
  /** 非 team 成员 primary 会话的第二行：`名字@primary`（拿不到节点地址时才有值）。 */
  agentLabels: ReadonlyMap<string, string>;
  agentRetiredLabels: ReadonlyMap<string, string>;
  /** 归属到已停用 agent 的会话 id：只用来加「待移除」标记，不参与过滤。 */
  defaultSession?: { sessionId: string; label: string; bodyCount: number };
  primarySessionIds: ReadonlySet<string>;
  query: string;
  onQueryChange: (value: string) => void;
  searchSnippets?: ReadonlyMap<string, string>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasToken: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onRename: (sessionId: string, title: string) => Promise<boolean>;
  onDelete: (session: SessionInfo) => void;
  onViewRuns: (sessionId: string) => void;
  onShowMore: () => void;
  compact: boolean;
  onCloseDrawer: () => void;
  onOpenConnection: () => void;
  writesDisabled: boolean;
  renameSignal: number;
  sessionsOpen: boolean;
  drawerRef: RefObject<HTMLElement | null>;
  panes: PaneResizeApi;
}) {
  const drawerA11y = compact ? { role: 'dialog' as const, 'aria-modal': sessionsOpen } : {};

  return (
    <>
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
          sessions={sessions}
          hiddenCount={hiddenCount}
          selectedId={selectedId}
          draftActive={draftActive}
          pendingBySession={pendingBySession}
          inflightBySession={inflightBySession}
          {...(pendingAskCount !== undefined ? { pendingAskCount } : {})}
          {...(onOpenPending !== undefined ? { onOpenPending } : {})}
          agentAddresses={agentAddresses}
          agentAddressesById={agentAddressesById}
          agentDepths={agentDepths}
          agentLabels={agentLabels}
          agentRetiredLabels={agentRetiredLabels}
          defaultSession={defaultSession}
          primarySessionIds={primarySessionIds}
          query={query}
          onQueryChange={onQueryChange}
          searchSnippets={searchSnippets}
          loading={loading}
          error={error}
          onRetry={onRetry}
          hasToken={hasToken}
          onSelect={onSelect}
          onNew={onNew}
          onRename={onRename}
          onDelete={onDelete}
          onViewRuns={onViewRuns}
          onShowMore={onShowMore}
          compact={compact}
          onCloseDrawer={onCloseDrawer}
          onOpenConnection={onOpenConnection}
          writesDisabled={writesDisabled}
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
          onClick={onCloseDrawer}
        />
      )}
    </>
  );
});
