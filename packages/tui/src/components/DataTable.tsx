/**
 * 通用表格渲染（纯展示，不用 useInput）
 * @module @vessel-agent/tui
 *
 * 所有单元格走 fitCell，保证终端显示宽度精确；不在这里做过滤/滚动/RPC。
 */

import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { fitCell } from '../utils/text-layout.js';
import {
  COLUMN_GAP,
  formatRowPrefix,
  type ResolvedColumn,
  TABLE_PREFIX_WIDTH,
} from '../views/layout.js';
import { toneColor } from '../views/tones.js';
import type { TableView, ViewRow } from '../views/types.js';
import { EmptyState } from './EmptyState.js';

export interface DataTableProps {
  view: TableView;
  columns: ResolvedColumn[];
  /** 当前可见窗口内的行（已切片） */
  rows: ViewRow[];
  selectedKey?: string | null;
  /** rows[0] 在原列表中的索引（用于序号） */
  start?: number;
  showHeader?: boolean;
  emptyHint?: string;
}

function markerFor(row: ViewRow, selected: boolean): '›' | '●' | ' ' {
  if (selected) return '›';
  if (row.current) return '●';
  return ' ';
}

export function DataTable({
  view,
  columns,
  rows,
  selectedKey,
  start = 0,
  showHeader = true,
  emptyHint,
}: DataTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={view.emptyText ?? 'No items.'}
        {...(emptyHint ? { hint: emptyHint } : {})}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Box>
          <Text color={theme.faint} bold>
            {' '.repeat(TABLE_PREFIX_WIDTH)}
          </Text>
          {columns.map(({ column, width }, index) => (
            <Text key={column.key} color={theme.faint} bold wrap="truncate-end">
              {fitCell(column.header, width, column.align ?? 'left')}
              {index < columns.length - 1 ? ' '.repeat(COLUMN_GAP) : ''}
            </Text>
          ))}
        </Box>
      ) : null}

      {rows.map((row, offset) => {
        const index = start + offset;
        const selected =
          selectedKey !== null && selectedKey !== undefined && row.key === selectedKey;
        const marker = markerFor(row, selected);
        const markerColor = selected ? theme.brand : row.current ? theme.ok : theme.faint;
        const rowColor = selected
          ? theme.brand
          : toneColor(row.tone ?? (row.current ? 'ok' : 'muted'));

        return (
          <Box key={row.key}>
            <Text color={markerColor} bold={selected}>
              {formatRowPrefix(marker, index)}
            </Text>
            {columns.map(({ column, width }, cellIndex) => (
              <Text key={column.key} color={rowColor} bold={selected} wrap="truncate-end">
                {fitCell(row.cells[column.key] ?? '', width, column.align ?? 'left')}
                {cellIndex < columns.length - 1 ? ' '.repeat(COLUMN_GAP) : ''}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
