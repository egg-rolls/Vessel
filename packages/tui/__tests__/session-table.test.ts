import { describe, expect, it } from 'bun:test';
import { clampSelection } from '../src/components/SessionTable.js';

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
