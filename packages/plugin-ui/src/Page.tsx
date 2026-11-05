import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * 插件页的宿主口径页面容器。
 *
 * 与 Web 主页面保持一致：`max-w-[var(--content-max)]` + `p-6 pb-10`，小屏
 * `max-compact:px-3 pt-4 pb-7`。插件 iframe 是全空间，所以由插件自己套这一层，
 * 视觉边距才能和 Vessel 其它页面一致。
 */
export function PluginPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[var(--content-max)] flex-col gap-4 p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 页面标题 + 一小段用途说明（LiteLLM 风格）。标题层级与主 Web 的 22px 标题对齐；
 * 说明只放一句短文案，不写实现细节。
 */
export function PluginPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-title font-semibold text-ink">{title}</h1>
        {actions !== undefined ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {description !== undefined && description !== '' ? (
        <p className="max-w-prose text-md leading-normal text-muted">{description}</p>
      ) : null}
    </header>
  );
}
