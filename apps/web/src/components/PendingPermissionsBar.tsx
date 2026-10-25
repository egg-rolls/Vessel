import { pendingBarSummary, pendingBarTarget } from '../domains/chat/pending-permissions';
import type { AskUserRequest, PermissionRequest } from '../gateway/types';
import { t } from '../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/**
 * 全局待处理 compact bar（0.18）：单条，不展开、不按会话分行。
 *
 * - 只提示其他会话的 pending 权限 / 提问，跳最早一条的所属会话；
 *   最早一条无归属会话时只显示失效提示，不给死链。
 * - 已失效（orphaned）交互不在这里占位：Observe → Attention 可查看，
 *   hydration 后只由一次性 toast 提示。
 */
export function PendingPermissionsBar({
  requests,
  asks = [],
  onOpenSession,
}: {
  requests: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  onOpenSession: (sessionId: string) => void;
}) {
  const summary = pendingBarSummary(requests, asks);
  const earliest = summary.earliest;
  const target = pendingBarTarget(summary);
  if (!earliest) return null;

  return (
    <div className="pending-permissions-bar" role="status">
      <span>{t('pending.bar.summary', { count: summary.count })}</span>
      <span className="dim mono">{t('pending.run', { id: shortId(earliest.runId) })}</span>
      {target ? (
        <button type="button" className="link-btn" onClick={() => onOpenSession(target.sessionId)}>
          {t('permission.goTo')}
        </button>
      ) : (
        <span className="dim">{t('pending.bar.unresolved')}</span>
      )}
    </div>
  );
}
