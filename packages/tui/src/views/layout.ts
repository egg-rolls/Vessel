/**
 * 视图布局——纯函数
 * @module @vessel/tui
 *
 * 宽度单位是终端列。列选择规则（与设计文档 §2.4 / §4.2 一致）：
 * priority 1 总是显示；priority 2 需要 >=100 列；priority 3 需要 >=120 列。
 * 任何情况下都不能超过可用宽度：先丢低优先级列，再压缩固定列。
 */

import {
  displayWidth,
  fitCell,
  padToWidth,
  truncateToWidth,
  wrapToWidth,
} from '../utils/text-layout.js';
import type { ViewColumn } from './types.js';

export { displayWidth, fitCell, padToWidth, truncateToWidth, wrapToWidth };

/** 视图最大宽度（含边框） */
export const VIEW_MAX_WIDTH = 120;
/** 左右预留列数，避免贴边 */
export const VIEW_HORIZONTAL_MARGIN = 2;
/** 列间距（固定 2 空格） */
export const COLUMN_GAP = 2;
/**
 * 表格行首前缀宽度：标记(1) + 空格(1) + 三位序号(3) + 两空格(2) = 7。
 * 表头与数据行共用 `formatRowPrefix`，且列宽预算必须先扣掉这 7 列。
 * 三位序号覆盖 /trace 的 500 条上限；超过 999 条时序号列会自然变宽。
 */
export const TABLE_PREFIX_WIDTH = 7;

/** 纯函数：数据行前缀（标记 + 右对齐序号 + 两个空格），宽度恒为 TABLE_PREFIX_WIDTH */
export function formatRowPrefix(marker: string, index: number): string {
  return `${marker} ${String(index + 1).padStart(3, ' ')}  `;
}
/** 宽屏断点：priority 2 / 3 */
export const WIDE_COLUMNS = 100;
export const XL_COLUMNS = 120;

export type WidthClass = 'xs' | 'sm' | 'md' | 'lg';

/** 纯函数：视图宽度 `max(1, min(columns - 2, 120))` */
export function viewWidth(columns: number | undefined): number {
  const cols =
    columns !== undefined && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  return Math.max(1, Math.min(cols - VIEW_HORIZONTAL_MARGIN, VIEW_MAX_WIDTH));
}

/** 内容区宽度 = 视图宽度 - 边框 2 - 左右 padding 2 */
export function viewContentWidth(columns: number | undefined): number {
  return Math.max(1, viewWidth(columns) - 4);
}

/** 按终端列数分档：xs < 70，sm < 100，md < 120，lg >= 120 */
export function widthClass(columns: number): WidthClass {
  if (columns < 70) return 'xs';
  if (columns < WIDE_COLUMNS) return 'sm';
  if (columns < XL_COLUMNS) return 'md';
  return 'lg';
}

/** priority 对应的最小终端列数 */
export function priorityThreshold(priority: ViewColumn['priority']): number {
  if (priority === 2) return WIDE_COLUMNS;
  if (priority === 3) return XL_COLUMNS;
  return 0;
}

export interface ResolvedColumn {
  column: ViewColumn;
  /** 单元格宽度（不含列间距） */
  width: number;
}

function columnMinWidth(column: ViewColumn): number {
  return Math.max(1, column.minWidth ?? 1);
}

function fixedWidth(column: ViewColumn): number | null {
  return column.width !== undefined && Number.isFinite(column.width)
    ? Math.max(1, Math.floor(column.width))
    : null;
}

/**
 * 选择可见列并分配宽度。
 *
 * @param columns 视图列定义
 * @param availableWidth 可供单元格 + 列间距使用的总宽度
 * @param terminalColumns 终端列数（用于 priority 门槛；缺省取 availableWidth + 4）
 */
export function resolveColumns(
  columns: ViewColumn[],
  availableWidth: number,
  terminalColumns?: number,
): ResolvedColumn[] {
  const terminal =
    terminalColumns !== undefined && Number.isFinite(terminalColumns)
      ? terminalColumns
      : availableWidth + 4;
  const available = Math.max(1, Math.floor(availableWidth));

  let visible = columns.filter((column) => terminal >= priorityThreshold(column.priority ?? 1));
  // priority 过滤后不能为空：退化为第一列（列定义本身来自命令层）。
  if (visible.length === 0) visible = columns.slice(0, 1);
  if (visible.length === 0) return [];

  const gaps = (count: number): number => Math.max(0, count - 1) * COLUMN_GAP;
  const cellsWidth = (items: ViewColumn[]): number => {
    let total = 0;
    for (const column of items) {
      total += fixedWidth(column) ?? columnMinWidth(column);
    }
    return total;
  };

  // 先丢低优先级列（从末尾），直到固定最小宽度能放下。
  while (visible.length > 1 && cellsWidth(visible) + gaps(visible.length) > available) {
    let dropIndex = -1;
    for (let i = visible.length - 1; i >= 0; i--) {
      const column = visible[i];
      if (column && (column.priority ?? 1) > 1) {
        dropIndex = i;
        break;
      }
    }
    if (dropIndex < 0) dropIndex = visible.length - 1;
    visible = visible.filter((_, index) => index !== dropIndex);
  }

  const gapTotal = gaps(visible.length);
  const cellsBudget = Math.max(visible.length, available - gapTotal);

  const fixedColumns = visible.filter((column) => fixedWidth(column) !== null);
  const flexColumns = visible.filter((column) => fixedWidth(column) === null);
  let fixedTotal = 0;
  for (const column of fixedColumns) fixedTotal += fixedWidth(column) ?? 0;

  // 固定列本身超宽：按从末尾到开头压缩，最小 1 列。
  if (fixedTotal > cellsBudget) {
    const widths = new Map<ViewColumn, number>();
    for (const column of fixedColumns) widths.set(column, fixedWidth(column) ?? 1);
    let overflow = fixedTotal - cellsBudget;
    for (let i = fixedColumns.length - 1; i >= 0 && overflow > 0; i--) {
      const column = fixedColumns[i];
      if (!column) continue;
      const current = widths.get(column) ?? 1;
      const shrink = Math.min(current - 1, overflow);
      widths.set(column, current - shrink);
      overflow -= shrink;
    }
    const resolved: ResolvedColumn[] = [];
    for (const column of visible) {
      const fixed = widths.get(column);
      if (fixed !== undefined) resolved.push({ column, width: fixed });
    }
    // flex 列在固定列吃满预算时退化为 1 列，但仍保留可见性。
    for (const column of flexColumns) resolved.push({ column, width: 1 });
    return orderResolved(visible, resolved);
  }

  const flexBudget = Math.max(0, cellsBudget - fixedTotal);
  const perFlex = flexColumns.length > 0 ? Math.floor(flexBudget / flexColumns.length) : 0;
  const resolved = visible.map<ResolvedColumn>((column) => {
    const fixed = fixedWidth(column);
    if (fixed !== null) return { column, width: fixed };
    return { column, width: Math.max(columnMinWidth(column), perFlex || 1) };
  });

  // flex 列的最小宽度之和可能超过预算：按末尾压缩。
  let total = resolved.reduce((sum, item) => sum + item.width, 0);
  for (let i = resolved.length - 1; i >= 0 && total > cellsBudget; i--) {
    const item = resolved[i];
    if (!item) continue;
    const shrink = Math.min(item.width - 1, total - cellsBudget);
    item.width -= shrink;
    total -= shrink;
  }

  return resolved;
}

function orderResolved(order: ViewColumn[], resolved: ResolvedColumn[]): ResolvedColumn[] {
  const byColumn = new Map(resolved.map((item) => [item.column, item] as const));
  const ordered: ResolvedColumn[] = [];
  for (const column of order) {
    const item = byColumn.get(column);
    if (item) ordered.push(item);
  }
  return ordered;
}

/** 把一行按已解析列渲染成固定宽度的单行文本（不含指针/序号前缀） */
export function formatTableRow(cells: Record<string, string>, columns: ResolvedColumn[]): string {
  return columns
    .map(({ column, width }) => fitCell(cells[column.key] ?? '', width, column.align ?? 'left'))
    .join(' '.repeat(COLUMN_GAP));
}

/** 表头行（与数据行同宽） */
export function formatTableHeader(columns: ResolvedColumn[]): string {
  return columns
    .map(({ column, width }) => fitCell(column.header, width, column.align ?? 'left'))
    .join(' '.repeat(COLUMN_GAP));
}

export interface ScrollWindow {
  start: number;
  /** 不含 */
  end: number;
}

/**
 * 围绕选中项计算可见窗口；末尾贴底。
 * total/capacity 非正时返回空窗口。
 */
export function scrollWindow(total: number, selected: number, capacity: number): ScrollWindow {
  if (total <= 0 || capacity <= 0) return { start: 0, end: 0 };
  const size = Math.min(Math.floor(capacity), total);
  const maxStart = total - size;
  const target = Math.floor(size / 2);
  const start = Math.min(Math.max(0, selected - target), maxStart);
  return { start, end: start + size };
}
