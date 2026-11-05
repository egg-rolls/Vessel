import type { ReactNode } from 'react';
import { cn } from './cn';

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
 * 宿主与插件共用，不要再复制一份 header。头部只允许标题与说明；
 * actions / 搜索 / tab / 计数 / 状态 chip 一律属于 content 区
 * （表格工具栏 / stat 行 / Section header）。标题字号与 Web
 * `EntityHeader` page 尺寸逐字一致（`font-serif text-title`）。
 */
export function PageScaffold({ title, subtitle, children, className }: PageScaffoldProps) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[var(--content-max)] flex-col p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7',
        className,
      )}
    >
      <header className="flex flex-col gap-2.5">
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
