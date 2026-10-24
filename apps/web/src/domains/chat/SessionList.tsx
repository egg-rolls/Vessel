import { Fragment, useEffect, useRef, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { StatusGlyph } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { IconButton, Tooltip } from '../../components/Tooltip';
import { SearchInput } from '../../components/ui';
import { relativeTime } from '../../format';
import type { SessionInfo } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { groupSessionsByDay, normalizeSessionTitle, sessionTitle } from '../../state/sessions';
import { highlightSegments } from './highlight';

export function SessionList({
  sessions,
  hiddenCount,
  selectedId,
  draftActive,
  pendingBySession,
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
}: {
  sessions: readonly SessionInfo[];
  hiddenCount: number;
  selectedId: string | null;
  draftActive: boolean;
  /** 每个会话的待处理权限/提问数量；其他会话只显示徽标，不渲染卡片。 */
  pendingBySession?: ReadonlyMap<string, number>;
  query: string;
  onQueryChange: (value: string) => void;
  /** 服务端搜索命中的片段；query 非空时优先展示。 */
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
  /** 断线时禁用重命名/删除，保留只读动作。 */
  writesDisabled: boolean;
  /** 命令面板触发当前会话行内重命名；每次递增。 */
  renameSignal: number;
}) {
  useLocale();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const committing = useRef(false);
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingId) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [editingId]);

  const startRename = (session: SessionInfo) => {
    setEditingId(session.session_id);
    setDraft(sessionTitle(session));
    setRenameError(null);
  };

  // 命令面板 → 行内重命名；只在 signal 变化时触发，轮询刷新不会重开编辑器。
  const lastRenameSignal = useRef(0);
  useEffect(() => {
    if (renameSignal === lastRenameSignal.current) return;
    lastRenameSignal.current = renameSignal;
    if (writesDisabled || !selectedId) return;
    const target = sessions.find((session) => session.session_id === selectedId);
    if (!target) return;
    setEditingId(target.session_id);
    setDraft(sessionTitle(target));
    setRenameError(null);
  }, [renameSignal, sessions, selectedId, writesDisabled]);

  const cancelRename = () => {
    setEditingId(null);
    setDraft('');
    setRenameError(null);
  };

  const commitRename = async (sessionId: string) => {
    if (committing.current) return;
    const title = normalizeSessionTitle(draft);
    if (!title) {
      setRenameError(t('chat.sessionList.renameEmpty'));
      return;
    }
    committing.current = true;
    const ok = await onRename(sessionId, title);
    committing.current = false;
    if (ok) cancelRename();
    else setRenameError(t('chat.sessionList.renameFailed'));
  };

  const copyId = (sessionId: string) => {
    if (!navigator.clipboard?.writeText) {
      toast.error(t('common.clipboardUnsupported'));
      return;
    }
    void navigator.clipboard
      .writeText(sessionId)
      .then(() => toast.success(t('chat.session.copiedId')))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  return (
    <div className="session-column">
      <div className="column-header">
        <h2 className="column-title">{t('chat.sessionList.title')}</h2>
        <button type="button" className="btn btn-small btn-primary" onClick={onNew}>
          {t('chat.sessionList.new')}
        </button>
        {compact && (
          <IconButton label={t('nav.closeSessions')} onClick={onCloseDrawer}>
            ×
          </IconButton>
        )}
      </div>

      <div className="session-controls">
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={t('chat.sessionList.search')}
          ariaLabel={t('chat.sessionList.search')}
        />
      </div>

      <div className="session-scroll">
        {error && sessions.length > 0 && (
          <StaleNotice message={t('common.staleData', { detail: error })} onRetry={onRetry} />
        )}
        {error && sessions.length === 0 ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !hasToken ? (
          <EmptyState
            title={t('chat.sessionList.noConnection')}
            action={
              <button type="button" className="btn" onClick={onOpenConnection}>
                {t('common.configureConnection')}
              </button>
            }
          />
        ) : loading && sessions.length === 0 ? (
          <LoadingState label={t('chat.sessionList.loading')} />
        ) : sessions.length === 0 ? (
          query.trim() ? (
            <EmptyState
              title={t('chat.sessionList.noMatch', { query: query.trim() })}
              action={
                <button type="button" className="btn" onClick={() => onQueryChange('')}>
                  {t('common.clearSearch')}
                </button>
              }
            />
          ) : (
            <EmptyState
              title={t('chat.sessionList.empty')}
              action={
                <button type="button" className="btn btn-primary" onClick={onNew}>
                  {t('common.newSession')}
                </button>
              }
            />
          )
        ) : (
          <>
            {draftActive && (
              <div className="session-row draft active">
                <div className="session-main">
                  <span className="session-title">{t('chat.draft.title')}</span>
                  <span className="session-preview">{t('chat.draft.meta')}</span>
                </div>
              </div>
            )}
            {groupSessionsByDay(sessions).map((group) => (
              <Fragment key={group.key || 'unknown'}>
                {group.label && (
                  <div className="session-day">
                    <span>{group.label}</span>
                  </div>
                )}
                {group.sessions.map((session) => {
                  const active = session.session_id === selectedId;
                  const editing = editingId === session.session_id;
                  const title = sessionTitle(session);
                  const pendingCount = pendingBySession?.get(session.session_id) ?? 0;
                  const relative = relativeTime(session.updated_at);
                  const snippet = query.trim()
                    ? searchSnippets?.get(session.session_id)
                    : undefined;
                  const preview =
                    snippet ??
                    (session.preview && session.preview !== session.title ? session.preview : '');
                  return (
                    <div
                      className={`session-row ${active ? 'active' : ''}`.trim()}
                      key={session.session_id}
                    >
                      {editing ? (
                        <div className="session-rename">
                          <input
                            ref={renameRef}
                            className="input"
                            value={draft}
                            aria-label={t('chat.sessionList.idLabel')}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              setDraft(event.target.value);
                              setRenameError(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void commitRename(session.session_id);
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={() => void commitRename(session.session_id)}
                          />
                          {renameError && (
                            <span className="field-error" role="alert">
                              {renameError}
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="session-main"
                            aria-current={active ? 'true' : undefined}
                            onClick={() => onSelect(session.session_id)}
                          >
                            <span className="session-title">
                              <StatusGlyph status={session.status} />
                              <Tooltip label={title}>
                                <span className="session-title-text">{title}</span>
                              </Tooltip>
                              {pendingCount > 0 && (
                                <Tooltip label={t('chat.session.pending', { count: pendingCount })}>
                                  <span className="session-pending-badge">
                                    <span aria-hidden="true">{pendingCount}</span>
                                    <span className="sr-only">
                                      {t('chat.session.pending', { count: pendingCount })}
                                    </span>
                                  </span>
                                </Tooltip>
                              )}
                              {relative && (
                                <span className="session-time">
                                  {t(
                                    relative.key,
                                    'params' in relative ? relative.params : undefined,
                                  )}
                                </span>
                              )}
                            </span>
                            {preview && (
                              <span className="session-preview">
                                {query.trim()
                                  ? highlightSegments(preview, query).map((segment) =>
                                      segment.match ? (
                                        <mark key={segment.start}>{segment.text}</mark>
                                      ) : (
                                        <Fragment key={segment.start}>{segment.text}</Fragment>
                                      ),
                                    )
                                  : preview}
                              </span>
                            )}
                          </button>
                          <ActionMenu
                            label={t('chat.sessionList.actions', { title })}
                            items={[
                              {
                                id: 'rename',
                                label: t('chat.sessionList.rename'),
                                disabled: writesDisabled,
                                onSelect: () => startRename(session),
                              },
                              {
                                id: 'copy',
                                label: t('chat.session.copyId'),
                                onSelect: () => copyId(session.session_id),
                              },
                              {
                                id: 'runs',
                                label: t('chat.sessionList.viewRuns'),
                                onSelect: () => onViewRuns(session.session_id),
                              },
                              {
                                id: 'delete',
                                label: t('chat.sessionList.delete'),
                                danger: true,
                                disabled: writesDisabled,
                                onSelect: () => onDelete(session),
                              },
                            ]}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
            {hiddenCount > 0 && (
              <button type="button" className="load-more" onClick={onShowMore}>
                {t('chat.sessionList.showMore', { count: hiddenCount })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
