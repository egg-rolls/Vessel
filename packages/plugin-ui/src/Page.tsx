import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * 插件页的宿主口径页面容器。
 *
 * 与 Web 主页面保持一致：`max-w-[var(--content-max)]` + `p-6 pb-10`，小屏
 * `max-compact:px-3 pt-4 pb-7`。插件 iframe 是全空间，所以由插件自己套这一层，
 * 视觉边距才能和 Vessel 其它页面一致。
 */
export function PluginPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[var(--content-max)] flex-col gap-5 p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageScaffoldProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** 只追加布局类；不得改标题语义色 / 字号。 */
  className?: string;
}

/**
 * 唯一的页面骨架：title + subtitle + content。
 *
 * 头部只允许标题与说明；actions / 搜索 / tab / 计数 / 状态 chip 一律属于 content
 * 区（表格工具栏 / stat 行 / Section header）。标题字号与 Web `EntityHeader`
 * page 尺寸逐字一致（`font-serif text-title`）。
 */
export function PageScaffold({ title, subtitle, children, className }: PageScaffoldProps) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[var(--content-max)] flex-col p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7',
        className,
      )}
    >
      <header className="flex flex-col gap-1.5">
        <h1 className="font-serif text-title font-semibold leading-tight tracking-wide text-ink">
          {title}
        </h1>
        {subtitle != null && subtitle !== '' ? (
          <p className="max-w-prose text-md leading-normal text-muted">{subtitle}</p>
        ) : null}
      </header>
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </div>
  );
}

/**
 * 兼容旧的页面标题组件。0.46 Wave 2：调用点迁移到 `PageScaffold` 后删除
 * `actions` 与组件本身；Wave 1 只修字号 / 间距。
 */
export function PluginPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  /**
   * @deprecated 0.46 Wave 2 删除。控件（筛选 / tab / 搜索 / 刷新 / 批量动作）
   * 属于 content，应放进 `TableToolbar` 或 Section header，不进页面头部。
   */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 font-serif text-title font-semibold leading-tight tracking-wide text-ink">
          {title}
        </h1>
        {actions !== undefined ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {description !== undefined && description !== '' ? (
        <p className="max-w-prose text-md leading-normal text-muted">{description}</p>
      ) : null}
    </header>
  );
}
