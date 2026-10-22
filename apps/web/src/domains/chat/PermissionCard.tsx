import { useEffect, useState } from 'react';
import type { PermissionRequest, PermissionScope } from '../../gateway/types';
import { t } from '../../i18n';

/** 序列化安全上限：超出只保留前 20,000 字符并标记截断。 */
const INPUT_CHAR_LIMIT = 20_000;
/** 折叠阈值：默认只显示前 12 行。 */
const COLLAPSED_LINES = 12;

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** 完整 pretty JSON（上限 20,000 字符），返回文本与是否截断。 */
export function serializeInput(input: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }
  if (text.length > INPUT_CHAR_LIMIT) {
    return { text: truncate(text, INPUT_CHAR_LIMIT), truncated: true };
  }
  return { text, truncated: false };
}

/** 折叠展示：展开时全文，否则只保留前 `limit` 行（纯函数，便于测试）。 */
export function visiblePermissionLines(
  text: string,
  expanded: boolean,
  limit = COLLAPSED_LINES,
): string {
  if (expanded) return text;
  const lines = text.split('\n');
  if (lines.length <= limit) return text;
  return lines.slice(0, limit).join('\n');
}

/**
 * 权限卡片：由 PermissionPrompt 渲染在 Composer 槽位（替换输入框），不再使用全局遮罩
 * （DECISION-024 §2.4）。
 *
 * Addendum A：权限等待默认不超时，因此不显示倒计时/过期；按钮只在提交中或断线时禁用。
 * 0.18 S2：长参数默认折叠 12 行（安全上限 20,000 字符），由槽位统一滚动。
 */
export function PermissionCard({
  request,
  busy = false,
  connected = true,
  onDecide,
}: {
  request: PermissionRequest;
  /** 提交中：禁用全部按钮，防止重复应答。 */
  busy?: boolean;
  /** 断线时禁用动作，避免点击升级成超时。 */
  connected?: boolean;
  onDecide: (decision: 'allow' | 'deny', scope: PermissionScope) => void;
}) {
  const titleId = `permission-${request.requestId}`;
  const [expanded, setExpanded] = useState(false);
  const serialized = serializeInput(request.input);
  const lines = serialized.text.split('\n');
  const canExpand = serialized.truncated || lines.length > COLLAPSED_LINES;
  const disabled = busy || !connected;
  const shown = visiblePermissionLines(serialized.text, expanded);

  // 切换请求时回到折叠态（ChatView 也会用 key 重挂载，这里双保险）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 requestId 变化时重置
  useEffect(() => {
    setExpanded(false);
  }, [request.requestId]);

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
      <pre className="permission-input">{shown}</pre>
      {canExpand && (
        <button
          type="button"
          className="link-btn permission-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('permission.collapse') : t('permission.expand')}
        </button>
      )}
      {serialized.truncated && (
        <span className="dim permission-truncated">{t('permission.truncated')}</span>
      )}
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
          {t('permission.allowOnce')}
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
