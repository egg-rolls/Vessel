import { describe, expect, it } from 'bun:test';
import { computeLiveLayout, type LiveMode } from '../src/repl/layout.js';

const NOTICE =
  'Terminal height is low (<15 rows); live output is hidden. Resize to see streaming output.';

interface Expected {
  rows: number;
  mode: LiveMode;
  liveMaxHeight: number;
  streamMaxLines: number;
  autocompleteMax: number;
  pickerMaxRows: number;
  notice: string | null;
}

const CASES: Expected[] = [
  {
    rows: 5,
    mode: 'hidden',
    liveMaxHeight: 0,
    streamMaxLines: 0,
    autocompleteMax: 3,
    pickerMaxRows: 3,
    notice: NOTICE,
  },
  {
    rows: 10,
    mode: 'hidden',
    liveMaxHeight: 0,
    streamMaxLines: 0,
    autocompleteMax: 3,
    pickerMaxRows: 3,
    notice: NOTICE,
  },
  {
    rows: 11,
    mode: 'minimal',
    liveMaxHeight: 0,
    streamMaxLines: 0,
    autocompleteMax: 3,
    pickerMaxRows: 5,
    notice: NOTICE,
  },
  {
    rows: 14,
    mode: 'minimal',
    liveMaxHeight: 0,
    streamMaxLines: 0,
    autocompleteMax: 3,
    pickerMaxRows: 5,
    notice: NOTICE,
  },
  {
    rows: 15,
    mode: 'compact',
    liveMaxHeight: 3,
    streamMaxLines: 3,
    autocompleteMax: 3,
    pickerMaxRows: 10,
    notice: null,
  },
  {
    rows: 19,
    mode: 'compact',
    liveMaxHeight: 7,
    streamMaxLines: 7,
    autocompleteMax: 5,
    pickerMaxRows: 10,
    notice: null,
  },
  {
    rows: 20,
    mode: 'normal',
    liveMaxHeight: 8,
    streamMaxLines: 6,
    autocompleteMax: 8,
    pickerMaxRows: 15,
    notice: null,
  },
  {
    rows: 23,
    mode: 'normal',
    liveMaxHeight: 11,
    streamMaxLines: 9,
    autocompleteMax: 8,
    pickerMaxRows: 15,
    notice: null,
  },
  {
    rows: 24,
    mode: 'normal',
    liveMaxHeight: 12,
    streamMaxLines: 10,
    autocompleteMax: 8,
    pickerMaxRows: 20,
    notice: null,
  },
  {
    rows: 30,
    mode: 'normal',
    liveMaxHeight: 18,
    streamMaxLines: 16,
    autocompleteMax: 8,
    pickerMaxRows: 20,
    notice: null,
  },
];

describe('computeLiveLayout', () => {
  for (const expected of CASES) {
    it(`${expected.rows} rows -> ${expected.mode}`, () => {
      expect(computeLiveLayout(expected.rows)).toEqual({
        mode: expected.mode,
        liveMaxHeight: expected.liveMaxHeight,
        streamMaxLines: expected.streamMaxLines,
        autocompleteMax: expected.autocompleteMax,
        pickerMaxRows: expected.pickerMaxRows,
        notice: expected.notice,
      });
    });
  }

  it('rows < 1 按 1 处理', () => {
    expect(computeLiveLayout(0)).toEqual(computeLiveLayout(1));
    expect(computeLiveLayout(-5)).toEqual(computeLiveLayout(1));
  });

  it('小数先取整', () => {
    expect(computeLiveLayout(14.9)).toEqual(computeLiveLayout(14));
    expect(computeLiveLayout(15.9)).toEqual(computeLiveLayout(15));
  });
});
