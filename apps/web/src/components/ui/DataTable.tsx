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
  /**
   * 表头吸顶。只在表格自身处于有界滚动容器内时开启；页面级表格保持
   * 默认 false，否则会钉在路由滚动容器顶部、压住 PageHeader / SegmentedTabs。
   */
  stickyHeader?: boolean;
}

const HIDE_CLASS: Record<DataTableHide, string> = {
  wide: 'max-wide:hidden',
  compact: 'max-compact:hidden',
};

/**
 * 语义数据表：行 hover / 选中底色、列断点隐藏与末列换行规则。
 * 表头默认不吸顶（页面级表格会被路由滚动容器钉在顶部、遮挡页头与 tab）；
 * 只有表格自己带滚动容器时才传 `stickyHeader`。只负责展示，不含排序 / 分页 / 虚拟化。
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  activeKey,
  className,
  stickyHeader = false,
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
                'h-9 bg-sunken px-2.5 py-1.5 text-left align-middle font-mono text-xs font-medium tracking-wide text-faint uppercase wrap-anywhere max-compact:px-1.5',
                stickyHeader && 'sticky top-0 z-1',
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
