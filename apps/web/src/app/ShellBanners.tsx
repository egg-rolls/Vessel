import type { ConnectionState } from '../gateway/client';
import { t } from '../i18n';

/** 外壳顶部的错误 / 鉴权 / 断线提示条。 */
export function ShellBanners({
  lastError,
  tokenError,
  stale,
  connectionState,
  reconnectAttempt,
  onDismissError,
  onRetry,
  onOpenConnection,
}: {
  lastError: string | null;
  tokenError: string | null;
  stale: boolean;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  onDismissError: () => void;
  onRetry: () => void;
  onOpenConnection: () => void;
}) {
  if (!(lastError || tokenError || stale)) return null;
  return (
    <div className="flex flex-none flex-col">
      {lastError && (
        <div className="banner banner-error" role="alert">
          <span>{lastError}</span>
          <button
            type="button"
            className="banner-close"
            aria-label={t('app.closeError')}
            onClick={onDismissError}
          >
            ×
          </button>
        </div>
      )}
      {tokenError && (
        <div className="banner banner-error" role="alert">
          <span>{tokenError}</span>
          <button type="button" className="link-btn" onClick={onOpenConnection}>
            {t('app.openConnection')}
          </button>
        </div>
      )}
      {stale && (
        <div className="banner banner-stale" role="status">
          <span>
            {connectionState === 'reconnecting'
              ? t('app.reconnecting', { count: Math.max(1, reconnectAttempt) })
              : t('app.stale')}
          </span>
          <button type="button" className="link-btn" onClick={onRetry}>
            {t('app.retryNow')}
          </button>
          <button type="button" className="link-btn" onClick={onOpenConnection}>
            {t('app.connectionSettings')}
          </button>
        </div>
      )}
    </div>
  );
}
