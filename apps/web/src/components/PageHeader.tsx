import type { ReactNode } from 'react';
import { t } from '../i18n';

/** 页面标题：唯一 h1 + active tenant + 可选的 default-tenant 作用域说明。 */
export function PageHeader({
  title,
  description,
  tenantId,
  scopeNote,
  actions,
}: {
  title: string;
  description?: ReactNode;
  tenantId?: string | null;
  scopeNote?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1 className="page-title">{title}</h1>
        {description && <div className="page-desc">{description}</div>}
        <div className="page-scope">
          <span className="scope-chip" title={t('nav.tenantCurrent')}>
            {t('common.tenant')} {tenantId ?? '—'}
          </span>
          {scopeNote && <span className="scope-chip muted">{scopeNote}</span>}
        </div>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
