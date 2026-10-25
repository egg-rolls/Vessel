import type { ReactNode } from 'react';
import { cn } from './cn';

/** 列在宽屏 / 小屏下的隐藏档位：wide = ≤1023，compact = ≤680。 */
export type DataTableHide = 'wide' | 'compact';

export interface DataTableColumn<Row> {
  /** 稳定列键，只用于 React key。 */
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** 断点隐藏：`wide` 在 ≤1023 隐藏，`compact` 在 ≤680 隐藏。 */
  hide?: DataTableHide;
  /** 追加到 `<td>` 的类（字体 / 数值对齐等）。 */
  cellClassName?: string;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** 与 `rowKey` 相等的行使用强调底色（当前/选中行高亮）。 */
  activeKey?: string;
  /** 追加到 `<table>` 的布局类。 */
  className?: string;
}

const HIDE_CLASS: Record<DataTableHide, string> = {
  wide: 'max-wide:hidden',
  compact: 'max-compact:hidden',
};

/**
 * 语义数据表：表头 sticky、行 hover / 选中底色、列断点隐藏与末列换行规则。
 * 只负责展示，不含排序 / 分页 / 虚拟化。
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  activeKey,
  className,
}: DataTableProps<Row>) {
  return (
    <table className={cn('w-full border-collapse bg-raised text-md', className)}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                'sticky top-0 z-1 h-9 bg-sunken px-2.5 py-1.5 text-left align-middle font-mono text-xs font-medium tracking-wide text-faint uppercase wrap-anywhere max-compact:px-1.5',
                column.hide && HIDE_CLASS[column.hide],
              )}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr
              key={key}
              data-active={key === activeKey || undefined}
              className="hover:bg-hover data-[active=true]:bg-accent-soft data-[active=true]:text-accent-ink"
            >
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={cn(
                    'h-9 px-2.5 py-1.5 align-middle wrap-anywhere max-compact:px-1.5',
                    index === columns.length - 1 && 'whitespace-nowrap max-wide:whitespace-normal',
                    column.hide && HIDE_CLASS[column.hide],
                    column.cellClassName,
                  )}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
