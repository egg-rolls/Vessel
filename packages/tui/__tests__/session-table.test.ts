import { describe, expect, it } from 'bun:test';
import { clampSelection } from '../src/components/SessionTable.js';
import { displayWidth, truncateToWidth } from '../src/utils/text-layout.js';
import {
  COLUMN_GAP,
  resolveColumns,
  TABLE_PREFIX_WIDTH,
  viewContentWidth,
} from '../src/views/layout.js';
import { sessionColumns } from '../src/views/session-picker.js';

describe('clampSelection', () => {
  it('把索引钳制到 [0, len-1]', () => {
    expect(clampSelection(-1, 3)).toBe(0);
    expect(clampSelection(0, 3)).toBe(0);
    expect(clampSelection(2, 3)).toBe(2);
    expect(clampSelection(9, 3)).toBe(2);
  });

  it('空列表返回 0，绝不返回 -1', () => {
    expect(clampSelection(-1, 0)).toBe(0);
    expect(clampSelection(0, 0)).toBe(0);
    expect(clampSelection(5, 0)).toBe(0);
  });
});

describe('picker 列宽回归（80 列不溢出）', () => {
  it('80 列下单元格 + 列间距 + 前缀不超过内容宽度', () => {
    const columns = resolveColumns(
      sessionColumns(80),
      viewContentWidth(80) - TABLE_PREFIX_WIDTH,
      80,
    );
    const cells = columns.reduce((sum, column) => sum + column.width, 0);
    const gaps = Math.max(0, columns.length - 1) * COLUMN_GAP;
    expect(TABLE_PREFIX_WIDTH + cells + gaps).toBeLessThanOrEqual(viewContentWidth(80));
  });

  it('100/120 列同理', () => {
    for (const terminal of [100, 120]) {
      const columns = resolveColumns(
        sessionColumns(terminal),
        viewContentWidth(terminal) - TABLE_PREFIX_WIDTH,
        terminal,
      );
      const cells = columns.reduce((sum, column) => sum + column.width, 0);
      const gaps = Math.max(0, columns.length - 1) * COLUMN_GAP;
      expect(TABLE_PREFIX_WIDTH + cells + gaps).toBeLessThanOrEqual(viewContentWidth(terminal));
    }
  });

  it('CJK 标题按显示宽度截断（不再用 .length/.slice）', () => {
    const out = truncateToWidth('修复登录问题并继续之前的上下文', 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });
});
