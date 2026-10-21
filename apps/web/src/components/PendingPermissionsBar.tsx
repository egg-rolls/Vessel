import type { AskUserRequest, PermissionRequest } from '../gateway/types';
import { t } from '../i18n';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function targetOf(request: { sessionId?: string; runId: string }): string {
  return request.sessionId ?? request.runId;
}

/** 当前视图外的待处理请求（权限 + 提问）条：只提示 + 跳转，不打断当前对话。 */
export function PendingPermissionsBar({
  requests,
  asks = [],
  onOpen,
  onOpenAsk,
  panelOpen = false,
  onTogglePanel,
}: {
  requests: readonly PermissionRequest[];
  asks?: readonly AskUserRequest[];
  onOpen: (request: PermissionRequest) => void;
  onOpenAsk?: (request: AskUserRequest) => void;
  /** 非模态待处理面板是否展开（0.17）。 */
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}) {
  const first = requests[0];
  const firstAsk = asks[0];
  if (!first && !firstAsk) return null;
  const labels = [...new Set([...requests.map(targetOf), ...asks.map(targetOf)])]
    .slice(0, 2)
    .map(shortId);
  const openAsk = onOpenAsk ?? (() => undefined);
  return (
    <div className="pending-permissions-bar" role="status">
      {requests.length > 0 && (
        <span>{t('permission.otherSessions', { count: requests.length })}</span>
      )}
      {asks.length > 0 && <span>{t('ask.otherSessions', { count: asks.length })}</span>}
      <span className="dim mono">{labels.join(', ')}</span>
      {first && (
        <button type="button" className="link-btn" onClick={() => onOpen(first)}>
          {t('permission.goTo')}
        </button>
      )}
      {firstAsk && (
        <button type="button" className="link-btn" onClick={() => openAsk(firstAsk)}>
          {t('ask.goTo')}
        </button>
      )}
      {onTogglePanel && (
        <button
          type="button"
          className="link-btn"
          aria-expanded={panelOpen}
          aria-controls="pending-requests-panel"
          onClick={onTogglePanel}
        >
          {panelOpen ? t('pending.panel.collapse') : t('pending.panel.toggle')}
        </button>
      )}
    </div>
  );
}
