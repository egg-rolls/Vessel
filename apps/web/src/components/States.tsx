import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Button, cn } from './ui';

/** 状态块外壳：迁移后统一由 L1 token utilities 组成。 */
const stateShell = 'flex flex-col gap-2 rounded-md bg-sunken px-5 py-7';
const stateIcon = 'flex-none text-lg leading-none text-muted';
const stateTitle = 'font-serif text-lg leading-snug text-ink';
const stateDesc = 'max-w-prose text-md leading-relaxed text-muted wrap-anywhere';
const stateAction = 'mt-1 flex flex-wrap gap-2';

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
    <div className={cn('state-empty', stateShell)}>
      <span className={stateIcon} aria-hidden="true">
        ○
      </span>
      <p className={stateTitle}>{title}</p>
      {description && <p className={stateDesc}>{description}</p>}
      {action && <div className={stateAction}>{action}</div>}
    </div>
  );
}

/** 首次加载：带标签的占位行，不显示空态。 */
export function LoadingState({ label, rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className={cn('state-loading', stateShell)} aria-busy="true" aria-live="polite">
      <p className={stateDesc}>{label ?? t('common.loading')}</p>
      <div className="mt-1.5 flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: Math.max(1, rows) }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定数量的占位行
          <span className="skeleton-pulse h-3 rounded-full bg-sunken" key={index} />
        ))}
      </div>
    </div>
  );
}

/** 错误：摘要 + Retry；role=alert 但不抢焦点。 */
export function ErrorState({
  message,
  onRetry,
  retryLabel,
  action,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn('state-error', stateShell, 'bg-danger-soft text-danger')} role="alert">
      <span className={cn(stateIcon, 'text-danger')} aria-hidden="true">
        !
      </span>
      <p className={cn(stateTitle, 'text-danger')}>{t('common.loadFailed')}</p>
      <p className={cn(stateDesc, 'font-mono text-sm text-danger')}>{message}</p>
      {(onRetry || action) && (
        <div className={stateAction}>
          {onRetry && <Button onClick={onRetry}>{retryLabel ?? t('common.retry')}</Button>}
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
    <div className={cn('state-not-enabled', stateShell)}>
      <span className={stateIcon} aria-hidden="true">
        ?
      </span>
      <p className={stateTitle}>{title}</p>
      {reason && <p className={stateDesc}>{reason}</p>}
      {hint && <p className="font-mono text-sm text-faint">{hint}</p>}
      {action && <div className={stateAction}>{action}</div>}
    </div>
  );
}

/** 有旧数据但更新失败/离线：不阻塞内容。 */
export function StaleNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="stale-notice flex flex-wrap items-center gap-2.5 rounded-sm bg-warn-soft px-3 py-2 text-sm text-warn"
      role="status"
    >
      <span className="flex-none text-lg leading-none text-warn" aria-hidden="true">
        !
      </span>
      <span>{message}</span>
      {onRetry && (
        <Button variant="link" className="text-warn hover:text-warn" onClick={onRetry}>
          {t('common.refresh')}
        </Button>
      )}
    </div>
  );
}
