import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LIMIT,
  DEFAULT_MEMBERS_LIMIT,
  MAX_LIMIT,
  MAX_MEMBERS_LIMIT,
  memberWindowFlags,
  nextLimitFor,
  nextMembersLimitFor,
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

  test('member window grows by 80 to the hard cap of 100', () => {
    expect(nextMembersLimitFor(DEFAULT_MEMBERS_LIMIT)).toBe(MAX_MEMBERS_LIMIT);
    // 已到上限不能再加，也不能越过服务端 100 的最大值。
    expect(nextMembersLimitFor(MAX_MEMBERS_LIMIT)).toBe(MAX_MEMBERS_LIMIT);

    expect(memberWindowFlags(20, 50, 20)).toEqual({ canLoadMore: true, capped: false });
    expect(memberWindowFlags(50, 50, 100)).toEqual({ canLoadMore: false, capped: false });
    // 到 100 仍不足：只能提示“仅显示前 100”，不能再发请求。
    expect(memberWindowFlags(100, 150, 100)).toEqual({ canLoadMore: false, capped: true });
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
