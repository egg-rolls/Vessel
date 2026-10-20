import { describe, expect, it } from 'bun:test';
import {
  COLUMN_GAP,
  displayWidth,
  fitCell,
  formatRowPrefix,
  formatTableHeader,
  formatTableRow,
  resolveColumns,
  scrollWindow,
  TABLE_PREFIX_WIDTH,
  viewContentWidth,
  viewWidth,
  widthClass,
} from '../src/views/layout.js';
import type { ViewColumn } from '../src/views/types.js';

const COLUMNS: ViewColumn[] = [
  { key: 'title', header: 'TITLE', priority: 1, minWidth: 24 },
  { key: 'id', header: 'ID', width: 21, priority: 2 },
  { key: 'branch', header: 'BRANCH', width: 12, priority: 2 },
  { key: 'status', header: 'STATUS', width: 10, priority: 3 },
];

function totalWidth(columns: ReturnType<typeof resolveColumns>): number {
  return (
    columns.reduce((sum, column) => sum + column.width, 0) +
    Math.max(0, columns.length - 1) * COLUMN_GAP
  );
}

describe('viewWidth', () => {
  it('40/80/120/160/200 列随终端增长，200 列使用全宽（不封顶）', () => {
    expect(viewWidth(40)).toBe(38);
    expect(viewWidth(80)).toBe(78);
    expect(viewWidth(120)).toBe(118);
    expect(viewWidth(160)).toBe(158);
    expect(viewWidth(200)).toBe(198);
  });

  it('异常宽度兜底', () => {
    expect(viewWidth(undefined)).toBe(78);
    expect(viewWidth(Number.NaN)).toBe(78);
    expect(viewWidth(1)).toBe(1);
  });

  it('内容宽度 = 视图宽度 - 边框/内边距 4', () => {
    expect(viewContentWidth(80)).toBe(74);
    expect(viewContentWidth(100)).toBe(94);
    expect(viewContentWidth(120)).toBe(114);
  });

  it('宽度分档', () => {
    expect(widthClass(60)).toBe('xs');
    expect(widthClass(80)).toBe('sm');
    expect(widthClass(100)).toBe('md');
    expect(widthClass(120)).toBe('lg');
  });
});

describe('resolveColumns', () => {
  it('priority 2/3 分别需要 100/120 列', () => {
    expect(resolveColumns(COLUMNS, 74, 80).map((c) => c.column.key)).toEqual(['title']);
    expect(resolveColumns(COLUMNS, 94, 99).map((c) => c.column.key)).toEqual(['title']);
    expect(resolveColumns(COLUMNS, 94, 100).map((c) => c.column.key)).toEqual([
      'title',
      'id',
      'branch',
    ]);
    expect(resolveColumns(COLUMNS, 114, 120).map((c) => c.column.key)).toEqual([
      'title',
      'id',
      'branch',
      'status',
    ]);
  });

  it('任何宽度下都不超过可用宽度', () => {
    for (const available of [1, 10, 24, 40, 74, 94, 114]) {
      const resolved = resolveColumns(COLUMNS, available, 120);
      expect(totalWidth(resolved)).toBeLessThanOrEqual(Math.max(available, resolved.length));
    }
  });

  it('flex 列分到剩余空间并遵守 minWidth', () => {
    const resolved = resolveColumns(COLUMNS, 94, 100);
    const title = resolved.find((item) => item.column.key === 'title');
    expect(title).toBeDefined();
    expect(title?.width).toBeGreaterThanOrEqual(24);
  });

  it('空列定义返回空数组', () => {
    expect(resolveColumns([], 80)).toEqual([]);
  });
});

describe('表格行前缀（表头/数据行对齐）', () => {
  it('所有标记的前缀宽度都等于 TABLE_PREFIX_WIDTH', () => {
    for (const marker of ['›', '●', ' ']) {
      expect(displayWidth(formatRowPrefix(marker, 0))).toBe(TABLE_PREFIX_WIDTH);
      expect(displayWidth(formatRowPrefix(marker, 9))).toBe(TABLE_PREFIX_WIDTH);
      expect(displayWidth(formatRowPrefix(marker, 99))).toBe(TABLE_PREFIX_WIDTH);
    }
  });

  it('表头与数据行总宽度一致，且整行不超过内容宽度', () => {
    for (const terminal of [80, 100, 120]) {
      const resolved = resolveColumns(
        [
          { key: 'title', header: 'TITLE', priority: 1, minWidth: 24 },
          { key: 'msgs', header: 'MSGS', width: 5, align: 'right', priority: 1 },
        ],
        viewContentWidth(terminal) - TABLE_PREFIX_WIDTH,
        terminal,
      );
      const headerWidth = TABLE_PREFIX_WIDTH + displayWidth(formatTableHeader(resolved));
      const rowWidth =
        TABLE_PREFIX_WIDTH +
        displayWidth(formatTableRow({ title: '中文标题', msgs: '3' }, resolved));
      expect(rowWidth).toBe(headerWidth);
      expect(rowWidth).toBeLessThanOrEqual(viewContentWidth(terminal));
    }
  });
});

describe('formatTableRow / formatTableHeader', () => {
  const columns = resolveColumns(COLUMNS, 94, 100);

  it('每行宽度一致（折行安全）', () => {
    const header = formatTableHeader(columns);
    const row = formatTableRow(
      { title: '中文标题', id: '20260101_120000_abc', branch: 'feat/auth', status: 'ok' },
      columns,
    );
    expect(displayWidth(header)).toBe(displayWidth(row));
  });

  it('CJK 内容被截断到列宽', () => {
    const resolved = resolveColumns([{ key: 'title', header: 'TITLE', width: 6 }], 6, 80);
    const row = formatTableRow({ title: '中文标题很长' }, resolved);
    expect(displayWidth(row)).toBe(6);
    expect(row).toContain('…');
  });
});

describe('scrollWindow', () => {
  it('列表短于容量时覆盖全部', () => {
    expect(scrollWindow(3, 0, 10)).toEqual({ start: 0, end: 3 });
    expect(scrollWindow(10, 5, 10)).toEqual({ start: 0, end: 10 });
  });

  it('围绕选中项滚动，末尾贴底', () => {
    expect(scrollWindow(30, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(scrollWindow(30, 12, 10)).toEqual({ start: 7, end: 17 });
    expect(scrollWindow(30, 29, 10)).toEqual({ start: 20, end: 30 });
  });

  it('选中项始终在窗口内', () => {
    for (const selected of [0, 1, 9, 10, 19, 29]) {
      const { start, end } = scrollWindow(30, selected, 10);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
    }
  });

  it('空列表 / 非法容量返回空窗口', () => {
    expect(scrollWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(scrollWindow(10, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('CJK 单元格适配', () => {
  it('fitCell 右对齐中文', () => {
    expect(fitCell('中文', 6, 'right')).toBe('  中文');
    expect(displayWidth(fitCell('中文', 6, 'right'))).toBe(6);
  });
});
