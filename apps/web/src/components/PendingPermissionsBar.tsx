import { pendingBarSummary, pendingBarTarget } from '../domains/chat/pending-permissions';
import type { OrphanedInteraction } from '../gateway/interaction-hydration';
import type { AskUserRequest, PermissionRequest } from '../gateway/types';
import { t } from '../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/**
 * 全局待处理 compact bar（0.18）：单条，不展开、不按会话分行。
 *
 * - pending：权限 + 提问合并计数，跳最早一条的所属会话；
 *   最早一条无归属会话时只显示失效提示，不给死链。
 * - orphaned：只提示 + 关闭（dismiss），不跳转、不提供应答。
 */
export function PendingPermissionsBar({
  requests,
  asks = [],
  orphaned = [],
  onOpenSession,
  onDismissOrphans,
}: {
  requests: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  /** 已失效交互：单独计数，不混入 pending 数量。 */
  orphaned?: readonly OrphanedInteraction[];
  onOpenSession: (sessionId: string) => void;
  onDismissOrphans: () => void;
}) {
  const summary = pendingBarSummary(requests, asks);
  const earliest = summary.earliest;
  const target = pendingBarTarget(summary);
  if (!earliest && orphaned.length === 0) return null;

  return (
    <div className="pending-permissions-bar" role="status">
      {earliest && (
        <>
          <span>{t('pending.bar.summary', { count: summary.count })}</span>
          <span className="dim mono">{t('pending.run', { id: shortId(earliest.runId) })}</span>
          {target ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => onOpenSession(target.sessionId)}
            >
              {t('permission.goTo')}
            </button>
          ) : (
            <span className="dim">{t('pending.bar.unresolved')}</span>
          )}
        </>
      )}
      {orphaned.length > 0 && (
        <>
          <span>{t('interaction.orphaned.bar', { count: orphaned.length })}</span>
          <button type="button" className="link-btn" onClick={onDismissOrphans}>
            {t('common.close')}
          </button>
        </>
      )}
    </div>
  );
}
