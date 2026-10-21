import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
} from '../../gateway/types';
import { t } from '../../i18n';
import { AskCard } from './AskCard';
import { PermissionCard } from './PermissionCard';

/**
 * 底部槽位的待处理权限 / 提问（0.18）。
 *
 * 它和 Composer 占用同一个位置：当前会话有 pending 时替换输入框，
 * 应答后请求从连接状态移除（run 终态也会清理），Composer 自动恢复。
 * 其他会话的 pending 不在页面顶部渲染完整卡片，只在会话列表上显示计数徽标。
 */
export function PendingComposer({
  permissions = [],
  asks = [],
  responding,
  now = Date.now(),
  onDecidePermission,
  onRespondAsk,
}: {
  permissions?: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  /** 正在提交应答的 requestId：按钮据此禁用。 */
  responding: ReadonlySet<string>;
  /** ask 倒计时用的当前时间。 */
  now?: number;
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
    <footer className="composer-area pending-composer">
      <section className="pending-slot" aria-label={t('chat.pending.label')} aria-live="polite">
        <div className="pending-slot-head">
          <span className="pending-slot-title">{t('chat.pending.title')}</span>
          <span className="dim">{t('pending.count', { count: total })}</span>
          <span className="dim pending-slot-hint">{t('chat.pending.hint')}</span>
        </div>
        <div className="pending-slot-list">
          {sortedPermissions.map((request) => (
            <PermissionCard
              key={request.requestId}
              request={request}
              busy={responding.has(request.requestId)}
              onDecide={(decision, scope) => onDecidePermission(request.requestId, decision, scope)}
            />
          ))}
          {sortedAsks.map((request) => (
            <AskCard
              key={request.requestId}
              request={request}
              pendingCount={sortedAsks.length}
              now={now}
              busy={responding.has(request.requestId)}
              onSubmit={(answers) => onRespondAsk(request.requestId, answers)}
              onCancel={() => onRespondAsk(request.requestId, [])}
            />
          ))}
        </div>
      </section>
    </footer>
  );
}
