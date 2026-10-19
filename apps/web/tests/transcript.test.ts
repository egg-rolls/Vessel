import { describe, expect, test } from 'bun:test';
import { windowTail } from '../src/transcript';

describe('windowTail', () => {
  const items = Object.freeze(['a', 'b', 'c', 'd', 'e']);

  test('limit 0 returns an empty window and hides everything', () => {
    const result = windowTail(items, 0);

    expect(result.shown).toEqual([]);
    expect(result.hiddenCount).toBe(items.length);
  });

  test('negative limit behaves like 0', () => {
    const result = windowTail(items, -3);

    expect(result.shown).toEqual([]);
    expect(result.hiddenCount).toBe(items.length);
  });

  test('limit 1 returns only the last item', () => {
    const result = windowTail(items, 1);

    expect(result.shown).toEqual(['e']);
    expect(result.hiddenCount).toBe(4);
  });

  test('limit smaller than length returns the tail', () => {
    const result = windowTail(items, 2);

    expect(result.shown).toEqual(['d', 'e']);
    expect(result.hiddenCount).toBe(3);
  });

  test('limit equal to length returns everything', () => {
    const result = windowTail(items, items.length);

    expect(result.shown).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.hiddenCount).toBe(0);
  });

  test('limit greater than length returns everything', () => {
    const result = windowTail(items, 99);

    expect(result.shown).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.hiddenCount).toBe(0);
  });

  test('an empty list stays empty', () => {
    const empty: readonly number[] = [];

    expect(windowTail(empty, 0)).toEqual({ shown: [], hiddenCount: 0 });
    expect(windowTail(empty, 5)).toEqual({ shown: [], hiddenCount: 0 });
  });

  test('does not mutate the input array', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const before = [...input];

    windowTail(input, 2);
    windowTail(input, 0);
    windowTail(input, 10);

    expect(input).toEqual(before);
  });

  test('returns a fresh array rather than the input reference', () => {
    const input = ['a', 'b', 'c'];
    const result = windowTail(input, input.length);

    expect(result.shown).not.toBe(input);
    expect(result.shown).toEqual(input);
  });

  test('preserves the element type', () => {
    const events = Object.freeze([{ id: 1 }, { id: 2 }]);
    const result = windowTail(events, 1);

    expect(result.shown).toEqual([{ id: 2 }]);
    expect(result.hiddenCount).toBe(1);
  });
});
