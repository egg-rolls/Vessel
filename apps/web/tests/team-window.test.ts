import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  nextLimitFor,
  teamWindowFlags,
} from '../src/domains/team/team-window';

describe('team message window', () => {
  test('grows 100 -> 200 -> 500 -> 1000 and stops at the cap', () => {
    expect(DEFAULT_LIMIT).toBe(100);
    expect(nextLimitFor(100)).toBe(200);
    expect(nextLimitFor(200)).toBe(500);
    expect(nextLimitFor(500)).toBe(1000);
    expect(nextLimitFor(1000)).toBe(MAX_LIMIT);
    // 反例：不能跳过 200 / 500 直接到 1000。
    expect(nextLimitFor(100)).not.toBe(1000);
  });

  test('reports truncation honestly without a has_more cursor', () => {
    expect(teamWindowFlags(100, 99)).toEqual({
      canLoadEarlier: false,
      historyLimited: false,
      visibleCount: 99,
    });
    expect(teamWindowFlags(100, 100)).toEqual({
      canLoadEarlier: true,
      historyLimited: true,
      visibleCount: 100,
    });
    expect(teamWindowFlags(MAX_LIMIT, MAX_LIMIT + 50)).toEqual({
      canLoadEarlier: false,
      historyLimited: true,
      visibleCount: MAX_LIMIT,
    });
  });
});
