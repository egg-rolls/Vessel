import { useEffect, useRef, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { CopyButton } from '../../components/CopyButton';
import { StatusChip } from '../../components/StatusChip';
import { formatTimestamp } from '../../format';
import type { SessionDetail, SessionInfo } from '../../gateway/types';
import { normalizeSessionTitle, sessionTitle } from '../../state/sessions';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function SessionHeader({
  session,
  sessionId,
  detail,
  refreshing,
  onRefresh,
  onRename,
  onDelete,
  onViewRuns,
  showInternal,
  onToggleInternal,
}: {
  session: SessionInfo | null;
  sessionId: string;
  detail: SessionDetail | null;
  refreshing: boolean;
  onRefresh: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
  onViewRuns: () => void;
  showInternal: boolean;
  onToggleInternal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const committing = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const title = session ? sessionTitle(session) : detail?.title?.trim() || sessionId;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(title);
    setEditing(true);
    setError(null);
  };

  const commit = async () => {
    if (committing.current) return;
    const next = normalizeSessionTitle(draft);
    if (!next) {
      setError('标题不能为空，且不超过 512 个字符');
      return;
    }
    committing.current = true;
    const ok = await onRename(next);
    committing.current = false;
    if (ok) setEditing(false);
    else setError('重命名失败，请重试');
  };

  return (
    <div className="conversation-head">
      <div className="conversation-heading">
        {editing ? (
          <div className="session-rename header-rename">
            <input
              ref={inputRef}
              className="input conversation-title-input"
              value={draft}
              aria-label="会话标题"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={() => void commit()}
            />
            {error && (
              <span className="field-error" role="alert">
                {error}
              </span>
            )}
          </div>
        ) : (
          <h2 className="conversation-title">{session ? title : truncate(title, 42)}</h2>
        )}
        <div className="conversation-meta dim">
          {session && <StatusChip status={session.status} />}
          {session ? (
            <span>
              {session.message_count} 条消息
              {session.updated_at ? ` · 更新于 ${formatTimestamp(session.updated_at)}` : ''}
            </span>
          ) : (
            <span>会话历史</span>
          )}
          <span className="mono session-id" title={sessionId}>
            {truncate(sessionId, 20)}
          </span>
          <CopyButton text={sessionId} label="复制 ID" toast="已复制会话 ID" />
        </div>
      </div>

      <div className="conversation-actions">
        <button type="button" className="btn btn-small" onClick={onViewRuns}>
          查看运行
        </button>
        <button
          type="button"
          className={`btn btn-small ${showInternal ? 'active' : ''}`.trim()}
          aria-pressed={showInternal}
          title="显示 context.changed / session.saved / llm.* 等内部事件"
          onClick={onToggleInternal}
        >
          内部事件
        </button>
        <button type="button" className="btn btn-small" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? '刷新中…' : '刷新历史'}
        </button>
        <ActionMenu
          label="会话操作"
          items={[
            { id: 'rename', label: '重命名', onSelect: start },
            { id: 'runs', label: '查看运行', onSelect: onViewRuns },
            { id: 'delete', label: '删除会话', danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </div>
  );
}
