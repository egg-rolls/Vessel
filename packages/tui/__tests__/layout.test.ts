import { describe, expect, it } from 'bun:test';
import {
  computeLiveLayout,
  type LiveMode,
  queuePreviewRows,
  STATUS_BAR_ROWS,
  showsQuickHint,
  viewCapacity,
  viewChromeRows,
  viewExtraRows,
} from '../src/repl/layout.js';

const BOUNDARIES: Array<{ rows: number; mode: LiveMode }> = [
  { rows: 5, mode: 'hidden' },
  { rows: 10, mode: 'hidden' },
  { rows: 11, mode: 'minimal' },
  { rows: 14, mode: 'minimal' },
  { rows: 15, mode: 'compact' },
  { rows: 19, mode: 'compact' },
  { rows: 20, mode: 'normal' },
  { rows: 23, mode: 'normal' },
  { rows: 24, mode: 'normal' },
  { rows: 60, mode: 'normal' },
];

describe('computeLiveLayout', () => {
  for (const expected of BOUNDARIES) {
    it(`${expected.rows} rows -> ${expected.mode}`, () => {
      expect(computeLiveLayout(expected.rows).mode).toBe(expected.mode);
    });
  }

  it('rows < 1 按 1 处理', () => {
    expect(computeLiveLayout(0)).toEqual(computeLiveLayout(1));
    expect(computeLiveLayout(-5)).toEqual(computeLiveLayout(1));
  });

  it('liveMaxHeight 非负且随终端变高不缩小', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { liveMaxHeight } = computeLiveLayout(rows);
      expect(liveMaxHeight).toBeGreaterThanOrEqual(0);
      expect(liveMaxHeight).toBeGreaterThanOrEqual(previous);
      previous = liveMaxHeight;
    }
  });

  it('normal/compact 至少保留 3 行 live 区', () => {
    for (let rows = 1; rows <= 60; rows++) {
      const { mode, liveMaxHeight } = computeLiveLayout(rows);
      if (mode === 'normal' || mode === 'compact') {
        expect(liveMaxHeight).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('autocompleteMax 在 1..8 且随终端变高不缩小', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { autocompleteMax } = computeLiveLayout(rows);
      expect(autocompleteMax).toBeGreaterThanOrEqual(1);
      expect(autocompleteMax).toBeLessThanOrEqual(8);
      expect(autocompleteMax).toBeGreaterThanOrEqual(previous);
      previous = autocompleteMax;
    }
  });

  it('normal 也有 picker/view 行数上限（不允许 undefined/无上限）', () => {
    for (const rows of [24, 30, 60, 100]) {
      expect(computeLiveLayout(rows).pickerMaxRows).toBeGreaterThan(0);
      expect(computeLiveLayout(rows).pickerMaxRows).toBeLessThanOrEqual(60);
      expect(computeLiveLayout(rows).viewMaxRows).toBeGreaterThan(0);
      expect(computeLiveLayout(rows).viewMaxRows).toBeLessThanOrEqual(60);
    }
  });

  it('viewMaxRows 随 height - chrome - status 连续增长（宽屏不再固定 20）', () => {
    const rows = [20, 24, 28, 32, 40, 60, 100];
    const capacities = rows.map((value) => computeLiveLayout(value).viewMaxRows);
    for (let index = 1; index < capacities.length; index++) {
      expect(capacities[index]).toBeGreaterThan(capacities[index - 1] ?? 0);
    }
    expect(capacities.at(-1)).toBe(60);
  });

  it('24/20/15/11/10 行的容量扣除 chrome 与状态栏', () => {
    const cases = [
      { rows: 24, mode: 'normal' as LiveMode, picker: 12, view: 12 },
      { rows: 20, mode: 'normal' as LiveMode, picker: 8, view: 8 },
      { rows: 15, mode: 'compact' as LiveMode, picker: 3, view: 3 },
      { rows: 11, mode: 'minimal' as LiveMode, picker: 2, view: 2 },
      { rows: 10, mode: 'hidden' as LiveMode, picker: 0, view: 0 },
    ];
    for (const expected of cases) {
      const layout = computeLiveLayout(expected.rows);
      expect(layout.mode).toBe(expected.mode);
      expect(layout.pickerMaxRows).toBe(expected.picker);
      expect(layout.viewMaxRows).toBe(expected.view);
      expect(viewCapacity(expected.rows, expected.mode, 'picker')).toBe(expected.picker);
      expect(viewCapacity(expected.rows, expected.mode, 'view')).toBe(expected.view);
    }
  });

  it('chrome + 数据行 + 状态栏不超过终端行数（non-hidden）', () => {
    for (const rows of [11, 14, 15, 20, 24, 40]) {
      const { mode, pickerMaxRows, viewMaxRows } = computeLiveLayout(rows);
      expect(viewChromeRows(mode, 'picker') + pickerMaxRows).toBeLessThanOrEqual(rows);
      expect(viewChromeRows(mode, 'view') + viewMaxRows).toBeLessThanOrEqual(rows);
    }
  });

  it('确认/重命名/notice 从容量中额外扣除', () => {
    expect(viewExtraRows('browse')).toBe(0);
    expect(viewExtraRows('filter')).toBe(0);
    expect(viewExtraRows('rename')).toBe(2);
    expect(viewExtraRows('confirm')).toBe(3);
    expect(viewExtraRows('browse', true)).toBe(2);
    expect(viewExtraRows('confirm', true)).toBe(5);
  });

  it('hidden（≤10 行）不预留数据行，整块只渲染一行摘要', () => {
    for (const rows of [1, 5, 10]) {
      const layout = computeLiveLayout(rows);
      expect(layout.mode).toBe('hidden');
      expect(layout.viewMaxRows).toBe(0);
      expect(layout.pickerMaxRows).toBe(0);
    }
  });

  it('viewMaxRows 非负且随终端变高不缩小', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { viewMaxRows } = computeLiveLayout(rows);
      expect(viewMaxRows).toBeGreaterThanOrEqual(0);
      expect(viewMaxRows).toBeGreaterThanOrEqual(previous);
      previous = viewMaxRows;
    }
  });

  it('pickerMaxRows 随高度分档且单调不减', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { pickerMaxRows } = computeLiveLayout(rows);
      expect(pickerMaxRows).toBeGreaterThanOrEqual(0);
      expect(pickerMaxRows).toBeGreaterThanOrEqual(previous);
      previous = pickerMaxRows;
    }
  });

  it('队列行数（含边框）从 live 预算扣除', () => {
    expect(computeLiveLayout(15, 0).liveMaxHeight).toBe(3);
    expect(computeLiveLayout(15, 3).liveMaxHeight).toBe(1);
    expect(computeLiveLayout(11, 3).liveMaxHeight).toBe(0);
    expect(computeLiveLayout(24, 5).liveMaxHeight).toBe(6);
  });

  it('queuePreviewRows：0 条 0 行，>3 条加尾行，含 2 行边框', () => {
    expect(queuePreviewRows(0, 24)).toBe(0);
    expect(queuePreviewRows(2, 24)).toBe(5);
    expect(queuePreviewRows(5, 24)).toBe(7);
    expect(queuePreviewRows(5, 10)).toBe(3);
  });

  it('状态栏边框占 3 行；80x24 加框后 live 仍为正且不溢出', () => {
    expect(STATUS_BAR_ROWS).toBe(3);
    const layout = computeLiveLayout(24);
    expect(layout.liveMaxHeight).toBeGreaterThan(0);
    expect(viewChromeRows(layout.mode, 'view') + layout.viewMaxRows).toBeLessThanOrEqual(24);
  });

  it('hintRows 只在 >=18 行出现', () => {
    expect(showsQuickHint(17)).toBe(false);
    expect(showsQuickHint(18)).toBe(true);
    expect(computeLiveLayout(17).hintRows).toBe(0);
    expect(computeLiveLayout(18).hintRows).toBe(1);
  });

  it('只有 minimal/hidden 给出过矮提示', () => {
    for (let rows = 1; rows <= 60; rows++) {
      const { mode, notice } = computeLiveLayout(rows);
      if (mode === 'minimal' || mode === 'hidden') {
        expect(notice).not.toBeNull();
      } else {
        expect(notice).toBeNull();
      }
    }
  });
});
