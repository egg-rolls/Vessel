import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';

export interface PagerProps {
  /** 无障碍名称（nav landmark）；调用方传已翻译文案（TableToolbar 同款口径）。 */
  label?: string;
  /** 范围文本（如「显示 1–50 / 123」）：调用方按 i18n 格式化传入，组件不算页码。 */
  rangeLabel: ReactNode;
  /** 上一页 / 下一页按钮文案（调用方传已翻译文案）。 */
  prevLabel: ReactNode;
  nextLabel: ReactNode;
  /** 边界如实：由调用方按真实 offset/total 推导，禁用态走 Button 基类透明度。 */
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** 尾注槽：索引生成时间等元信息，样式由调用方自定（如 text-faint）。 */
  children?: ReactNode;
  className?: string;
}

/**
 * 分页导航条（q-kanban-visual：替代 skills 页 raw flex 条，共享给未来看板 / 他页）。
 *
 * 设计口径（docs/dev/plans/kanban-visual-impl.md §2）：
 * - `nav` 语义 + aria-label，范围文本 `tabular-nums` 防翻页数字宽度跳动
 *   （RunEventLog 页码显示同款档位）；
 * - 按钮走 Button 默认 plain（sunken）表面——skills-style 先例（66d02d4f）
 *   裁定内容域用共享默认表面，GHOST 透黑底只供设置 / 运行日志域，不在此套用；
 * - 纯展示：不依赖 i18n / context / router（plugin-ui v1 约束），不持分页状态，
 *   文案与边界判定全部由调用方传入。
 */
export function Pager({
  label,
  rangeLabel,
  prevLabel,
  nextLabel,
  canPrev,
  canNext,
  onPrev,
  onNext,
  children,
  className,
}: PagerProps) {
  return (
    <nav
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-2.5 text-sm', className)}
    >
      <span className="text-muted tabular-nums">{rangeLabel}</span>
      <span className="flex items-center gap-1.5">
        <Button size="small" disabled={!canPrev} onClick={onPrev}>
          {prevLabel}
        </Button>
        <Button size="small" disabled={!canNext} onClick={onNext}>
          {nextLabel}
        </Button>
      </span>
      {children}
    </nav>
  );
}
