import { describe, expect, it } from 'bun:test';
import { computeLiveLayout, type LiveMode } from '../src/repl/layout.js';

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
    for (const rows of [24, 30, 60]) {
      expect(computeLiveLayout(rows).pickerMaxRows).toBe(20);
      expect(computeLiveLayout(rows).viewMaxRows).toBe(20);
    }
  });

  it('viewMaxRows 为正数且随模式单调不减', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { viewMaxRows } = computeLiveLayout(rows);
      expect(viewMaxRows).toBeGreaterThan(0);
      expect(viewMaxRows).toBeGreaterThanOrEqual(previous);
      previous = viewMaxRows;
    }
  });

  it('pickerMaxRows 随高度分档且单调不减', () => {
    let previous = 0;
    for (let rows = 1; rows <= 60; rows++) {
      const { pickerMaxRows } = computeLiveLayout(rows);
      expect(pickerMaxRows).toBeGreaterThan(0);
      expect(pickerMaxRows).toBeGreaterThanOrEqual(previous);
      previous = pickerMaxRows;
    }
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
