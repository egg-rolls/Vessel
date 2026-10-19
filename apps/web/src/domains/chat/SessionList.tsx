import { useEffect, useRef, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { formatTimestamp } from '../../format';
import type { SessionInfo } from '../../gateway/types';
import {
  normalizeSessionTitle,
  type SessionStatusFilter,
  sessionTitle,
} from '../../state/sessions';

const STATUS_FILTERS: readonly { id: SessionStatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
];

export function SessionList({
  sessions,
  filteredCount,
  totalCount,
  hiddenCount,
  selectedId,
  draftActive,
  query,
  onQueryChange,
  status,
  onStatusChange,
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
}: {
  sessions: readonly SessionInfo[];
  filteredCount: number;
  totalCount: number;
  hiddenCount: number;
  selectedId: string | null;
  draftActive: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  status: SessionStatusFilter;
  onStatusChange: (value: SessionStatusFilter) => void;
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
}) {
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
      .then(() => toast.success('已复制会话 ID'))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  const filterLabel = STATUS_FILTERS.find((item) => item.id === status)?.label ?? '全部';

  return (
    <div className="session-column">
      <div className="column-header">
        <h2 className="column-title">会话</h2>
        <span className="count-pill">
          {query.trim() || status !== 'all' ? `${filteredCount}/${totalCount}` : totalCount}
        </span>
        <button type="button" className="btn btn-small btn-primary" onClick={onNew}>
          ＋ 新建
        </button>
        {compact && (
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭会话列表"
            onClick={onCloseDrawer}
          >
            ×
          </button>
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
        <fieldset className="filter-chips">
          <legend className="sr-only">按状态过滤会话</legend>
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`filter-chip ${filter.id === status ? 'active' : ''}`.trim()}
              aria-pressed={filter.id === status}
              onClick={() => onStatusChange(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </fieldset>
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
          ) : status !== 'all' ? (
            <EmptyState
              title={`没有${filterLabel}的会话。`}
              action={
                <button type="button" className="btn" onClick={() => onStatusChange('all')}>
                  显示全部
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
            {sessions.map((session) => {
              const active = session.session_id === selectedId;
              const editing = editingId === session.session_id;
              const title = sessionTitle(session);
              const preview =
                session.preview && session.preview !== session.title ? session.preview : '';
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
                          {title}
                        </span>
                        {preview && <span className="session-preview">{preview}</span>}
                        <span className="session-meta">
                          <StatusChip status={session.status} />
                          <span>{session.message_count} 条</span>
                          <span className="dim">{formatTimestamp(session.updated_at)}</span>
                        </span>
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
                            label: '复制 ID',
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
