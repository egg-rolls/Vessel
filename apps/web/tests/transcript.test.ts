import { describe, expect, test } from 'bun:test';
import { windowTail } from '../src/transcript';

describe('windowTail', () => {
  const items = Object.freeze(['a', 'b', 'c', 'd', 'e']);

  test('non-positive limits hide everything', () => {
    for (const limit of [0, -3]) {
      const result = windowTail(items, limit);

      expect(result.shown).toEqual([]);
      expect(result.hiddenCount).toBe(items.length);
    }
  });

  test('positive limits return the tail without off-by-one', () => {
    const cases = [
      { limit: 1, shown: ['e'], hidden: 4 },
      { limit: 2, shown: ['d', 'e'], hidden: 3 },
      { limit: items.length, shown: [...items], hidden: 0 },
      { limit: 99, shown: [...items], hidden: 0 },
    ];

    for (const item of cases) {
      const result = windowTail(items, item.limit);

      expect(result.shown).toEqual(item.shown);
      expect(result.hiddenCount).toBe(item.hidden);
    }
  });

  test('does not mutate the input array', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const before = [...input];

    windowTail(input, 2);
    windowTail(input, 0);
    windowTail(input, 10);

    expect(input).toEqual(before);
  });
});
