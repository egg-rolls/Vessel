import { cn } from '@vessel-agent/plugin-ui';
import { t } from '../i18n';

/** 原始 JSON：默认折叠，避免诊断信息占据主视线。 */
export function JsonView({
  value,
  label = t('common.rawData'),
  open = false,
  maxHeight = 360,
  className,
}: {
  value: unknown;
  label?: string;
  open?: boolean;
  maxHeight?: number;
  /** 局部样式覆盖（如透黑底细线 GHOST_PANEL_CLASS）；默认仍是 legacy .json-view。 */
  className?: string;
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <details className={cn('json-view', className)} open={open}>
      <summary>{label}</summary>
      <pre className="json-body" style={{ maxHeight }}>
        {text}
      </pre>
    </details>
  );
}
