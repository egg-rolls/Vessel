import { t } from '../i18n';

/** 原始 JSON：默认折叠，避免诊断信息占据主视线。 */
export function JsonView({
  value,
  label = t('common.rawData'),
  open = false,
  maxHeight = 360,
}: {
  value: unknown;
  label?: string;
  open?: boolean;
  maxHeight?: number;
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <details className="json-view" open={open}>
      <summary>{label}</summary>
      <pre className="json-body" style={{ maxHeight }}>
        {text}
      </pre>
    </details>
  );
}
