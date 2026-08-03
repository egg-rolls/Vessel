import { describe, expect, it } from 'bun:test';
import { deepMerge } from '../src/utils.js';

describe('deepMerge', () => {
  it('should merge flat objects', () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3, c: 4 };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should not modify original objects', () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3 };
    deepMerge(base, override);
    expect(base).toEqual({ a: 1, b: 2 });
  });

  it('should skip undefined values in override', () => {
    const base = { a: 1, b: 2 };
    const override = { a: undefined, b: 3 };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('should recursively merge nested objects', () => {
    const base = {
      nested: { a: 1, b: 2 },
      other: 'value',
    };
    const override = {
      nested: { b: 3, c: 4 },
    };
    const result = deepMerge(base, override);
    expect(result).toEqual({
      nested: { a: 1, b: 3, c: 4 },
      other: 'value',
    });
  });

  it('should replace arrays instead of merging', () => {
    const base = {
      items: [1, 2, 3],
      nested: { arr: ['a', 'b'] },
    };
    const override = {
      items: [4, 5],
      nested: { arr: ['c'] },
    };
    const result = deepMerge(base, override);
    expect(result).toEqual({
      items: [4, 5],
      nested: { arr: ['c'] },
    });
  });

  it('should handle null values', () => {
    const base = { a: 1, b: { c: 2 } };
    const override = { a: null, b: null };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: null, b: null });
  });

  it('should handle nested objects with different depths', () => {
    const base = {
      level1: {
        level2: {
          level3: { a: 1 },
        },
      },
    };
    const override = {
      level1: {
        level2: {
          level3: { b: 2 },
        },
      },
    };
    const result = deepMerge(base, override);
    expect(result).toEqual({
      level1: {
        level2: {
          level3: { a: 1, b: 2 },
        },
      },
    });
  });

  it('should handle empty objects', () => {
    const base = { a: 1 };
    const override = {};
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1 });
  });

  it('should handle override with new nested object', () => {
    const base = { a: 1 };
    const override = { b: { c: 2 } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: { c: 2 } });
  });
});
