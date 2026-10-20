import { describe, expect, test } from 'bun:test';
import { defaultNavCollapsed, navModeForWidth, parseNavCollapsed } from '../src/app/layout';

describe('navModeForWidth', () => {
  test('does not move the drawer boundary at 680/681 or the rail boundary at 1023/1024', () => {
    expect(navModeForWidth(375, false)).toBe('drawer');
    expect(navModeForWidth(680, false)).toBe('drawer');
    expect(navModeForWidth(681, false)).toBe('rail');
    expect(navModeForWidth(1023, false)).toBe('rail');
    expect(navModeForWidth(1024, true)).toBe('collapsed');
    expect(navModeForWidth(1024, false)).toBe('expanded');
  });
});

describe('defaultNavCollapsed', () => {
  test('keeps 1024-1199 collapsed by default and 1200+ expanded', () => {
    expect(defaultNavCollapsed(1024)).toBe(true);
    expect(defaultNavCollapsed(1199)).toBe(true);
    expect(defaultNavCollapsed(1200)).toBe(false);
  });
});

describe('parseNavCollapsed', () => {
  test('treats unknown stored values as no preference', () => {
    expect(parseNavCollapsed('1')).toBe(true);
    expect(parseNavCollapsed('0')).toBe(false);
    expect(parseNavCollapsed('true')).toBeNull();
    expect(parseNavCollapsed(null)).toBeNull();
  });
});
