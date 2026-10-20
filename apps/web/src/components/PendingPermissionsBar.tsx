import type { PermissionRequest } from '../gateway/types';
import { t } from '../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/** 当前视图外的待处理请求条：只提示 + 跳转，不打断当前对话。 */
export function PendingPermissionsBar({
  requests,
  onOpen,
}: {
  requests: readonly PermissionRequest[];
  onOpen: (request: PermissionRequest) => void;
}) {
  const first = requests[0];
  if (!first) return null;
  const labels = [...new Set(requests.map((item) => item.sessionId ?? item.runId))]
    .slice(0, 2)
    .map(shortId);
  return (
    <div className="pending-permissions-bar" role="status">
      <span>{t('permission.otherSessions', { count: requests.length })}</span>
      <span className="dim mono">{labels.join(', ')}</span>
      <button type="button" className="link-btn" onClick={() => onOpen(first)}>
        {t('permission.goTo')}
      </button>
    </div>
  );
}
