import type { ReactNode } from 'react';
import { cn } from './cn';

/** 列在宽屏 / 小屏下的隐藏档位：wide = ≤1023，compact = ≤680。 */
export type DataTableHide = 'wide' | 'compact';

/** 受控排序状态：`key` 对应 `DataTableColumn.key`。 */
export interface DataTableSort {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableColumn<Row> {
  /** 稳定列键：React key，同时作为 `onSortChange` 回调参数。 */
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** 断点隐藏：`wide` 在 ≤1023 隐藏，`compact` 在 ≤680 隐藏。 */
  hide?: DataTableHide;
  /** 追加到 `<td>` 的类（字体 / 数值对齐等）。 */
  cellClassName?: string;
  /**
   * 可选：表头渲染为透明排序按钮，点击回调 `onSortChange(key)`。
   * 排序本身由调用方完成；未提供时表头保持纯文本。
   */
  sortable?: boolean;
  /**
   * 可选：把表头标题替换为带过滤控件的渲染结果（如状态 / agent 下拉）。
   * 不提供时保持纯文本表头；其它表格行为不变。与 `sortable` 同时存在时优先。
   */
  headerFilter?: (header: ReactNode) => ReactNode;
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
  /** 受控排序状态；只影响可排序列的箭头高亮，不改变行顺序。 */
  sort?: DataTableSort;
  /** 可排序列被点击时回调列 key；由调用方切换方向并重排。 */
  onSortChange?: (key: string) => void;
}

const HIDE_CLASS: Record<DataTableHide, string> = {
  wide: 'max-wide:hidden',
  compact: 'max-compact:hidden',
};

/**
 * 语义数据表：行 hover / 选中底色、列断点隐藏与末列换行规则。
 * 表头默认不吸顶（页面级表格会被路由滚动容器钉在顶部、遮挡页头与 tab）；
 * 只有表格自己带滚动容器时才传 `stickyHeader`。只负责展示，不含排序 / 分页 / 虚拟化。
 *
 * 行与行之间 1px 间隙：`border-separate` + `border-spacing-y-px`。间隙用表格
 * 自身的 `bg-bg` 垫底、行底色放在单元格上；这样无论外层是页面底色还是
 * `Section` 的 raised 底板，间隙都与行底色不同、始终可见（`bg-surface` 在亮色
 * 下与 raised 同值 #ffffff，会吞掉间隙，所以不用它）。圆角落在首行（表头）与
 * 末行的外角单元格上，容器若已 `overflow-hidden` 则是双层圆角（视觉等价）。
 *
 * 暗色下互换表头与内容底色（表头 raised、内容 sunken，让表头比行更亮），
 * 同时把表格垫底降到 `deep`，否则 1px 间隙与 sunken 行几乎同色而消失。
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  activeKey,
  className,
  stickyHeader = false,
  sort,
  onSortChange,
}: DataTableProps<Row>) {
  return (
    <table
      className={cn(
        'w-full rounded-md border-separate border-spacing-y-px bg-bg text-md dark:bg-deep',
        className,
      )}
    >
      <thead>
        <tr>
          {columns.map((column) => {
            const ascending =
              column.sortable && sort?.key === column.key && sort.direction === 'asc';
            const descending =
              column.sortable && sort?.key === column.key && sort.direction === 'desc';
            return (
              <th
                key={column.key}
                scope="col"
                aria-sort={
                  column.sortable
                    ? ascending
                      ? 'ascending'
                      : descending
                        ? 'descending'
                        : 'none'
                    : undefined
                }
                className={cn(
                  'h-9 bg-sunken px-2.5 py-1.5 text-left align-middle font-mono text-xs font-medium tracking-wide text-faint uppercase wrap-anywhere dark:bg-raised max-compact:px-1.5 first:rounded-tl-md last:rounded-tr-md',
                  stickyHeader && 'sticky top-0 z-1',
                  column.hide && HIDE_CLASS[column.hide],
                )}
              >
                {column.headerFilter ? (
                  column.headerFilter(column.header)
                ) : column.sortable ? (
                  <button
                    type="button"
                    onClick={() => onSortChange?.(column.key)}
                    className="inline-flex cursor-pointer items-center gap-1 bg-transparent p-0 text-left font-mono text-xs font-medium tracking-wide uppercase text-inherit hover:text-ink"
                  >
                    {column.header}
                    <span aria-hidden="true" className="inline-flex flex-none items-center gap-0.5">
                      <span className={ascending ? 'text-accent' : 'text-faint'}>↑</span>
                      <span className={descending ? 'text-accent' : 'text-faint'}>↓</span>
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => {
          const key = rowKey(row);
          const isLastRow = rowIndex === rows.length - 1;
          return (
            <tr
              key={key}
              data-active={key === activeKey || undefined}
              className="group data-[active=true]:text-accent-ink"
            >
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={cn(
                    'h-9 bg-raised px-2.5 py-1.5 align-middle wrap-anywhere group-hover:bg-hover group-data-[active=true]:bg-accent-soft dark:bg-sunken max-compact:px-1.5',
                    index === 0 && isLastRow && 'rounded-bl-md',
                    index === columns.length - 1 && isLastRow && 'rounded-br-md',
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
