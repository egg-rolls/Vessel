import type { PermissionRequest, PermissionScope } from '../../gateway/types';
import { t } from '../../i18n';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function prettyInput(input: unknown): string {
  try {
    return truncate(JSON.stringify(input, null, 2) ?? String(input), 2000);
  } catch {
    return String(input);
  }
}

/**
 * 内联权限卡片：挂在对应 RunCard 内，不再使用全局遮罩（DECISION-024 §2.4）。
 * 倒计时每秒由 ConnectionProvider 的 `now` 驱动，不做逐秒播报。
 */
export function PermissionCard({
  request,
  now,
  busy = false,
  onDecide,
}: {
  request: PermissionRequest;
  now: number;
  /** 提交中：禁用全部按钮，防止重复应答。 */
  busy?: boolean;
  onDecide: (decision: 'allow' | 'deny', scope: PermissionScope) => void;
}) {
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const expired = request.expiresAt <= now;
  const titleId = `permission-${request.requestId}`;
  const disabled = busy || expired;

  return (
    <fieldset
      className={`permission-card ${expired ? 'expired' : ''}`.trim()}
      aria-labelledby={titleId}
      data-request-id={request.requestId}
    >
      <div className="permission-card-head" id={titleId}>
        <span className="permission-tool mono">{request.tool}</span>
        <span className="permission-meta dim">
          {expired
            ? t('permission.inline.expired')
            : t('permission.inline.waiting', { seconds: remaining })}
        </span>
      </div>
      <pre className="permission-input">{prettyInput(request.input)}</pre>
      <div className="permission-card-actions">
        <button
          type="button"
          className="btn btn-danger-ghost"
          disabled={disabled}
          onClick={() => onDecide('deny', 'once')}
        >
          {t('permission.deny')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={() => onDecide('allow', 'once')}
        >
          {busy ? t('permission.busy') : t('permission.allowOnce')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => onDecide('allow', 'session')}
        >
          {t('permission.allowSession')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => onDecide('allow', 'always')}
        >
          {t('permission.always')}
        </button>
      </div>
    </fieldset>
  );
}
