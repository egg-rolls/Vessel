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
 * 权限卡片：渲染在 Composer 槽位（PendingComposer），不再使用全局遮罩（DECISION-024 §2.4）。
 *
 * Addendum A：权限等待默认不超时，因此不显示倒计时/过期；按钮只在提交中禁用。
 */
export function PermissionCard({
  request,
  busy = false,
  onDecide,
}: {
  request: PermissionRequest;
  /** 提交中：禁用全部按钮，防止重复应答。 */
  busy?: boolean;
  onDecide: (decision: 'allow' | 'deny', scope: PermissionScope) => void;
}) {
  const titleId = `permission-${request.requestId}`;

  return (
    <fieldset
      className="permission-card"
      aria-labelledby={titleId}
      data-request-id={request.requestId}
    >
      <div className="permission-card-head" id={titleId}>
        <span className="permission-tool mono">{request.tool}</span>
        <span className="permission-meta dim">
          {busy ? t('permission.busy') : t('permission.inline.waiting')}
        </span>
      </div>
      <pre className="permission-input">{prettyInput(request.input)}</pre>
      <div className="permission-card-actions">
        <button
          type="button"
          className="btn btn-danger-ghost"
          disabled={busy}
          onClick={() => onDecide('deny', 'once')}
        >
          {t('permission.deny')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => onDecide('allow', 'once')}
        >
          {t('permission.allowOnce')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => onDecide('allow', 'session')}
        >
          {t('permission.allowSession')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => onDecide('allow', 'always')}
        >
          {t('permission.always')}
        </button>
      </div>
    </fieldset>
  );
}
