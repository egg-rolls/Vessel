import type { ReactNode } from 'react';

/**
 * 页面标题：唯一 h1 + 可选的作用域说明。
 *
 * **不显示当前租户**：`AppBar` 的右侧已经在全局显示它（`nav.tenant`），
 * 每个页面再挂一枚 chip 是重复信息。
 */
export function PageHeader({
  title,
  description,
  scopeNote,
  actions,
}: {
  title: string;
  description?: ReactNode;
  /**
   * 已不渲染（见上方说明）。保留在签名里是为了不让 8 个调用方跟着改；
   * 删它要级联改 7 个视图组件的 props，收益不抵churn。
   */
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
        {scopeNote && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-faint">
              {scopeNote}
            </span>
          </div>
        )}
      </div>
      {actions && (
        <div className="flex flex-none flex-wrap items-start gap-2 max-compact:w-full">
          {actions}
        </div>
      )}
    </header>
  );
}
