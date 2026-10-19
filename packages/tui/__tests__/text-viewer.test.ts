import { describe, expect, it } from 'bun:test';
import { pagerRows, shouldPageOutput } from '../src/components/TextViewer.js';

describe('shouldPageOutput', () => {
  it('按非空行数判断，不把空行算成内容', () => {
    expect(shouldPageOutput('a\n\n\nb')).toBe(false);
    expect(shouldPageOutput('a\nb\nc')).toBe(true);
  });

  it('超长单行进入 pager', () => {
    expect(shouldPageOutput('x'.repeat(181))).toBe(true);
    expect(shouldPageOutput('x'.repeat(180))).toBe(false);
  });

  it('短输出留在 transcript', () => {
    expect(shouldPageOutput('one line')).toBe(false);
    expect(shouldPageOutput('')).toBe(false);
  });
});

describe('pagerRows', () => {
  it('页高 max(5, rows - 6)', () => {
    expect(pagerRows(24)).toBe(18);
    expect(pagerRows(8)).toBe(5);
    expect(pagerRows(Number.NaN)).toBe(18);
  });
});
