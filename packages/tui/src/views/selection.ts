/**
 * 视图选中项 -> 统一 ViewRow——纯函数
 * @module @vessel-agent/tui
 *
 * table 直接用行；list 把 item 归一为行（动作 enabled 判定需要 current 标记）；
 * detail 没有行选中，用 `DetailView.key` 合成一行，供 viewAction 的
 * selectionKey 与 confirm 文案使用。confirm/form 没有选中概念。
 */

import type { CommandView, DetailView, ListView, ViewRow } from './types.js';

/** 把 list item 归一为 ViewRow（cells.title = label） */
export function listItemRow(item: ListView['items'][number]): ViewRow {
  return {
    key: item.key,
    cells: { title: item.label },
    ...(item.current ? { current: true } : {}),
    ...(item.tone ? { tone: item.tone } : {}),
  };
}

/** 详情视图的合成行（key 为空时返回 null，避免伪造空选择） */
export function detailRow(view: DetailView): ViewRow | null {
  if (!view.key) return null;
  return { key: view.key, cells: { title: view.title } };
}

/**
 * 计算视图当前的选中行：
 * - table：调用方已按过滤/窗口解析出的行
 * - list：当前选中 item 的归一化行
 * - detail：view.key 合成行
 * - 其它：null
 */
export function viewSelectionRow(
  view: CommandView,
  tableRow: ViewRow | null | undefined,
  listItem: ListView['items'][number] | undefined,
): ViewRow | null {
  if (view.kind === 'table') return tableRow ?? null;
  if (view.kind === 'list') return listItem ? listItemRow(listItem) : null;
  if (view.kind === 'detail') return detailRow(view);
  return null;
}

/** 视图动作使用的 selectionKey（无选中时为空串） */
export function viewSelectionKey(row: ViewRow | null): string {
  return row?.key ?? '';
}

/** 视图自带上下文：三类带 key 的视图直接返回，其它为空 */
export function viewContextKey(view: CommandView): string | undefined {
  if (view.kind === 'table' || view.kind === 'list' || view.kind === 'detail') {
    return view.key;
  }
  return undefined;
}
