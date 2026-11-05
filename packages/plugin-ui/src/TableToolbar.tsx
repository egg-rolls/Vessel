import type { ReactNode } from 'react';
import { cn } from './cn';

export interface TableToolbarProps {
  children: ReactNode;
  /** 无障碍名称；调用方传已翻译文案。 */
  label?: string;
  className?: string;
}

/**
 * 表格 / Section 正上方的控件条。
 *
 * 筛选、范围 tab、搜索、刷新、批量动作都放这里；不得放进页面头部
 * （title / subtitle 行只放标题与说明）。
 */
export function TableToolbar({ children, label, className }: TableToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn('mb-2 flex flex-wrap items-center gap-2', className)}
    >
      {children}
    </div>
  );
}
