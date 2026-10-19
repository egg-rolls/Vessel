import type { ReactNode } from 'react';

/** 空态：一句解释 + 一个主行动。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-empty">
      <p className="state-title">{title}</p>
      {description && <p className="state-desc">{description}</p>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** 首次加载：带标签的占位行，不显示空态。 */
export function LoadingState({ label = '正在加载…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="state-loading" aria-busy="true" aria-live="polite">
      <p className="state-desc">{label}</p>
      <div className="skeleton" aria-hidden="true">
        {Array.from({ length: Math.max(1, rows) }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定数量的占位行
          <span className="skeleton-row" key={index} />
        ))}
      </div>
    </div>
  );
}

/** 错误：摘要 + Retry；role=alert 但不抢焦点。 */
export function ErrorState({
  message,
  onRetry,
  retryLabel = '重试',
  action,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-error" role="alert">
      <p className="state-title">加载失败</p>
      <p className="state-desc mono">{message}</p>
      {(onRetry || action) && (
        <div className="state-action">
          {onRetry && (
            <button type="button" className="btn" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

/** 能力未启用/无权限：原因 + 如何启用，不提供「重试」。 */
export function NotEnabledState({
  title,
  reason,
  hint,
  action,
}: {
  title: string;
  reason?: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-not-enabled">
      <p className="state-title">{title}</p>
      {reason && <p className="state-desc">{reason}</p>}
      {hint && <p className="state-hint mono">{hint}</p>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** 有旧数据但更新失败/离线：不阻塞内容。 */
export function StaleNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="stale-notice" role="status">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          刷新
        </button>
      )}
    </div>
  );
}
