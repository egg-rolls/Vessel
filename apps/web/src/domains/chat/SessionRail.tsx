import type { RefObject } from 'react';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { ResizeHandle } from '../../components/ResizeHandle';
import type { SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import { SessionList } from './SessionList';

/**
 * 左侧会话栏：列表 + 分栏拖拽 + compact 抽屉遮罩。
 * 纯展示；查询、选中、重命名、删除等动作由 ChatView 注入。
 */
export function SessionRail({
  sessions,
  hiddenCount,
  selectedId,
  draftActive,
  pendingBySession,
  agentAddresses,
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
  agentAddresses: ReadonlyMap<string, string>;
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
          agentAddresses={agentAddresses}
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
}
