import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Tooltip } from './Tooltip';

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
    <header className="flex items-center justify-between gap-4 max-compact:flex-col max-compact:items-start">
      <div className="min-w-0">
        <h1 className="break-words font-sans text-lg font-semibold leading-tight tracking-wide">
          {title}
        </h1>
        {description && (
          <div className="mt-0.5 text-md leading-normal text-muted">{description}</div>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Tooltip label={t('nav.tenantCurrent')}>
            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-muted">
              {t('common.tenant')} {tenantId ?? '—'}
            </span>
          </Tooltip>
          {scopeNote && (
            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-faint">
              {scopeNote}
            </span>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-none flex-wrap items-start gap-2 max-compact:w-full">
          {actions}
        </div>
      )}
    </header>
  );
}
