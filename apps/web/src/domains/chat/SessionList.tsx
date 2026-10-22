import { Fragment, useEffect, useRef, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { StatusGlyph } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { IconButton } from '../../components/Tooltip';
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
      setRenameError('标题不能为空，且不超过 512 个字符');
      return;
    }
    committing.current = true;
    const ok = await onRename(sessionId, title);
    committing.current = false;
    if (ok) cancelRename();
    else setRenameError('重命名失败，请重试');
  };

  const copyId = (sessionId: string) => {
    if (!navigator.clipboard?.writeText) {
      toast.error('当前环境不支持剪贴板');
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
        <h2 className="column-title">会话</h2>
        <button type="button" className="btn btn-small btn-primary" onClick={onNew}>
          ＋ 新建
        </button>
        {compact && (
          <IconButton label={t('nav.closeSessions')} onClick={onCloseDrawer}>
            ×
          </IconButton>
        )}
      </div>

      <div className="session-controls">
        <input
          className="input search-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索会话"
          type="search"
          aria-label="搜索会话"
          spellCheck={false}
        />
      </div>

      <div className="session-scroll">
        {error && sessions.length > 0 && (
          <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={onRetry} />
        )}
        {error && sessions.length === 0 ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : !hasToken ? (
          <EmptyState
            title="连接 gateway 后显示会话"
            action={
              <button type="button" className="btn" onClick={onOpenConnection}>
                配置连接
              </button>
            }
          />
        ) : loading && sessions.length === 0 ? (
          <LoadingState label="正在加载会话…" />
        ) : sessions.length === 0 ? (
          query.trim() ? (
            <EmptyState
              title={`没有匹配“${query.trim()}”的会话。`}
              action={
                <button type="button" className="btn" onClick={() => onQueryChange('')}>
                  清除搜索
                </button>
              }
            />
          ) : (
            <EmptyState
              title="还没有会话。"
              action={
                <button type="button" className="btn btn-primary" onClick={onNew}>
                  新建会话
                </button>
              }
            />
          )
        ) : (
          <>
            {draftActive && (
              <div className="session-row draft active">
                <div className="session-main">
                  <span className="session-title">新会话</span>
                  <span className="session-preview">发送第一条消息后创建</span>
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
                            aria-label="会话标题"
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
                            <span className="session-title" title={title}>
                              <StatusGlyph status={session.status} />
                              <span className="session-title-text">{title}</span>
                              {pendingCount > 0 && (
                                <span
                                  className="session-pending-badge"
                                  title={t('chat.session.pending', { count: pendingCount })}
                                >
                                  <span aria-hidden="true">{pendingCount}</span>
                                  <span className="sr-only">
                                    {t('chat.session.pending', { count: pendingCount })}
                                  </span>
                                </span>
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
                            label={`会话 ${title} 的操作`}
                            items={[
                              {
                                id: 'rename',
                                label: '重命名',
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
                                label: '查看运行',
                                onSelect: () => onViewRuns(session.session_id),
                              },
                              {
                                id: 'delete',
                                label: '删除会话',
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
                显示更多（还有 {hiddenCount} 个）
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
