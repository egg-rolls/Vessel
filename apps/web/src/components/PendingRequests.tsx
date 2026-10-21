import { AskCard } from '../domains/chat/AskCard';
import { PermissionCard } from '../domains/chat/PermissionCard';
import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
} from '../gateway/types';
import { t } from '../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function PendingCrumb({
  agentId,
  runId,
  sessionId,
}: {
  agentId?: string;
  runId: string;
  sessionId?: string;
}) {
  return (
    <div className="pending-entry-crumb mono">
      {agentId && <span>{t('pending.agent', { id: shortId(agentId) })}</span>}
      <span>{t('pending.run', { id: shortId(runId) })}</span>
      {sessionId && <span>{t('pending.session', { id: shortId(sessionId) })}</span>}
    </div>
  );
}

/**
 * 可操作的待处理请求列表（0.17 兜底面板）。
 *
 * - AppShell 用它展开其他会话 / 无 sessionId 的请求；
 * - 当前会话的请求由 ChatView 的 PendingComposer 在 Composer 槽位处理。
 * 两者都复用同一张 PermissionCard / AskCard，不恢复全局遮罩。
 */
export function PendingRequestsPanel({
  id,
  title,
  description,
  permissions = [],
  asks = [],
  responding,
  now = Date.now(),
  showSession = false,
  className = '',
  onDecidePermission,
  onRespondAsk,
}: {
  id?: string;
  title: string;
  description?: string;
  permissions?: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  /** 正在提交应答的 requestId：按钮据此禁用。 */
  responding: ReadonlySet<string>;
  /** ask 倒计时用的当前时间。 */
  now?: number;
  /** 跨会话面板显示归属 session；当前会话内不需要。 */
  showSession?: boolean;
  className?: string;
  onDecidePermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    scope: PermissionScope,
  ) => void;
  onRespondAsk: (requestId: string, answers: AskUserAnswer[]) => void;
}) {
  if (permissions.length === 0 && asks.length === 0) return null;

  const sortedPermissions = [...permissions].sort((a, b) => a.requestedAt - b.requestedAt);
  const sortedAsks = [...asks].sort((a, b) => a.expiresAt - b.expiresAt);
  const total = permissions.length + asks.length;

  return (
    <section id={id} className={`pending-requests ${className}`.trim()} aria-label={title}>
      <div className="pending-requests-head">
        <span className="pending-requests-title">{title}</span>
        <span className="pending-requests-count dim">{t('pending.count', { count: total })}</span>
      </div>
      {description && <p className="pending-requests-desc dim">{description}</p>}
      <div className="pending-requests-list">
        {sortedPermissions.map((request) => (
          <div className="pending-entry" key={`perm-${request.requestId}`}>
            <PendingCrumb
              agentId={request.agentId}
              runId={request.runId}
              sessionId={showSession ? request.sessionId : undefined}
            />
            <PermissionCard
              request={request}
              busy={responding.has(request.requestId)}
              onDecide={(decision, scope) => onDecidePermission(request.requestId, decision, scope)}
            />
          </div>
        ))}
        {sortedAsks.map((request) => (
          <div className="pending-entry" key={`ask-${request.requestId}`}>
            <PendingCrumb
              agentId={request.agentId}
              runId={request.runId}
              sessionId={showSession ? request.sessionId : undefined}
            />
            <AskCard
              request={request}
              pendingCount={sortedAsks.length}
              now={now}
              busy={responding.has(request.requestId)}
              onSubmit={(answers) => onRespondAsk(request.requestId, answers)}
              onCancel={() => onRespondAsk(request.requestId, [])}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
