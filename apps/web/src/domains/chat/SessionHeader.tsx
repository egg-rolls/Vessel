import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { formatTimestamp } from '../../format';
import type { SessionDetail, SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import {
  type AgentNode,
  type AgentTreeEntry,
  agentBreadcrumb,
  agentTree,
} from '../../state/agents';
import { sessionTitle } from '../../state/sessions';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function agentLabel(node: AgentNode): string {
  return node.task?.trim() || truncate(node.id, 16);
}

function agentUsageText(node: AgentNode): string | undefined {
  const total = node.usage?.total_tokens;
  if (total === undefined) return undefined;
  return `${total} tok`;
}

function AgentTreeRow({
  entry,
  activeAgentId,
  onSelectAgent,
}: {
  entry: AgentTreeEntry;
  activeAgentId?: string;
  onSelectAgent?: (id: string | undefined) => void;
}) {
  const node = entry.node;
  const duration =
    node.startedAt !== undefined && node.completedAt !== undefined
      ? `${node.completedAt - node.startedAt}ms`
      : undefined;
  const usage = agentUsageText(node);
  return (
    <li className="subagent-row">
      <div className="subagent-row-main" style={{ paddingLeft: `${node.depth * 12}px` }}>
        <StatusChip status={node.state} />
        <button
          type="button"
          className={`subagent-link ${node.id === activeAgentId ? 'active' : ''}`.trim()}
          aria-pressed={node.id === activeAgentId}
          title={node.id}
          onClick={() => onSelectAgent?.(node.id)}
        >
          {agentLabel(node)}
        </button>
        {node.currentTool && <span className="dim mono">{node.currentTool}</span>}
        {node.queuePosition !== undefined && (
          <span className="dim">
            {t('chat.subagents.queuePosition', { position: node.queuePosition })}
          </span>
        )}
        {node.waitReason && <span className="dim">{node.waitReason}</span>}
        {duration && <span className="dim">{duration}</span>}
        <details className="subagent-node-details">
          <summary>{t('chat.subagents.details')}</summary>
          <dl className="subagent-details">
            <dt>id</dt>
            <dd className="mono">{node.id}</dd>
            <dt>depth</dt>
            <dd>{node.depth}</dd>
            {node.runId && (
              <>
                <dt>run</dt>
                <dd className="mono">{node.runId}</dd>
              </>
            )}
            {node.sessionId && (
              <>
                <dt>session</dt>
                <dd className="mono">{node.sessionId}</dd>
              </>
            )}
            {usage && (
              <>
                <dt>usage</dt>
                <dd>{usage}</dd>
              </>
            )}
            {entry.children.length > 0 && (
              <>
                <dt>children</dt>
                <dd>{entry.children.length}</dd>
              </>
            )}
            {node.queuePosition !== undefined && (
              <>
                <dt>queue</dt>
                <dd>
                  {node.queuePosition}
                  {node.waitReason ? ` · ${node.waitReason}` : ''}
                </dd>
              </>
            )}
            {node.contextUsed !== undefined && node.contextMax !== undefined && (
              <>
                <dt>context</dt>
                <dd>
                  {node.contextUsed} / {node.contextMax}
                </dd>
              </>
            )}
            {node.lastSeen !== undefined && (
              <>
                <dt>last seen</dt>
                <dd>{formatTimestamp(node.lastSeen)}</dd>
              </>
            )}
            {node.nodeId && (
              <>
                <dt>node</dt>
                <dd className="mono">{node.nodeId}</dd>
              </>
            )}
            {node.lastError && (
              <>
                <dt>error</dt>
                <dd className="err">{truncate(node.lastError, 240)}</dd>
              </>
            )}
          </dl>
          <button type="button" className="btn btn-small" onClick={() => onSelectAgent?.(node.id)}>
            {t('chat.subagents.view')}
          </button>
        </details>
      </div>
      {entry.children.length > 0 && (
        <ul className="subagent-children">
          {entry.children.map((child) => (
            <AgentTreeRow
              key={child.node.id}
              entry={child}
              activeAgentId={activeAgentId}
              onSelectAgent={onSelectAgent}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SessionHeader({
  session,
  sessionId,
  detail,
  agents = [],
  activeAgentId,
  onSelectAgent,
}: {
  session: SessionInfo | null;
  sessionId: string;
  detail: SessionDetail | null;
  /** 0.14：当前会话的子 agent（由 `subagent.*` 事件派生）。 */
  agents?: readonly AgentNode[];
  /** `?agent=` 深链选中的子 agent。 */
  activeAgentId?: string;
  onSelectAgent?: (id: string | undefined) => void;
}) {
  const toast = useToast();
  const title = session ? sessionTitle(session) : detail?.title?.trim() || sessionId;
  const tree = agentTree(agents);
  const running = agents.filter((node) => node.state === 'running').length;
  const activeChain = activeAgentId ? agentBreadcrumb(agents, activeAgentId) : [];

  const copySessionId = () => {
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
    <div className="conversation-head">
      <div className="conversation-heading">
        {/* biome-ignore lint/a11y/useSemanticElements: title stays an h2; clicking it copies the session id */}
        <h2
          className="conversation-title"
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: title stays an h2; clicking it copies the session id
          role="button"
          tabIndex={0}
          aria-label={t('chat.session.copyIdTitle', { title })}
          title={t('chat.session.copyId')}
          onClick={copySessionId}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              copySessionId();
            }
          }}
        >
          {session ? title : truncate(title, 42)}
        </h2>
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
        </div>
        {activeAgentId && (
          <nav className="subagent-breadcrumb" aria-label={t('chat.subagents.title')}>
            <button type="button" className="btn-link" onClick={() => onSelectAgent?.(undefined)}>
              {t('chat.subagents.back')}
            </button>
            <span className="dim">/</span>
            {activeChain.map((node, index) => (
              <span key={node.id} className="subagent-crumb">
                {index > 0 && <span className="dim">/</span>}
                <button
                  type="button"
                  className={`btn-link ${node.id === activeAgentId ? 'active' : ''}`.trim()}
                  onClick={() => onSelectAgent?.(node.id)}
                >
                  {t('chat.subagents.crumb')} · {agentLabel(node)}
                </button>
              </span>
            ))}
          </nav>
        )}
        {agents.length > 0 && (
          <details className="subagent-tree" open={activeAgentId !== undefined}>
            <summary className="subagent-tree-summary">
              {t('chat.subagents.title')} · {agents.length}
              {running > 0 ? ` · ${t('chat.subagents.running', { count: running })}` : ''}
            </summary>
            <ul className="subagent-tree-list">
              {tree.map((entry) => (
                <AgentTreeRow
                  key={entry.node.id}
                  entry={entry}
                  activeAgentId={activeAgentId}
                  onSelectAgent={onSelectAgent}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
