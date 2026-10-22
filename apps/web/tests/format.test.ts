import { describe, expect, test } from 'bun:test';
import { formatTimestamp, formatTokenCount, relativeTime } from '../src/format';

/** Build an epoch-ms value from local calendar components. */
function localTs(
  year: number,
  monthIndex: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  millis = 0,
): number {
  return new Date(year, monthIndex, day, hours, minutes, seconds, millis).getTime();
}

describe('formatTimestamp', () => {
  test('returns an empty string for undefined', () => {
    expect(formatTimestamp(undefined)).toBe('');
  });

  test('same day renders HH:MM:SS with zero padding', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 15, 9, 5, 7);

    expect(formatTimestamp(ts, { now })).toBe('09:05:07');
  });

  test('same day with milliseconds renders .mmm', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 15, 9, 5, 7, 42);

    expect(formatTimestamp(ts, { now, withMs: true })).toBe('09:05:07.042');
  });

  test('different days render the full date', () => {
    const cases = [
      {
        // previous day: midnight boundary must not be treated as same-day
        now: localTs(2026, 0, 15, 0, 0, 1),
        ts: localTs(2026, 0, 14, 23, 59, 59),
        expected: '2026-01-14 23:59:59',
      },
      {
        // next day
        now: localTs(2026, 0, 15, 23, 59, 59),
        ts: localTs(2026, 0, 16, 0, 0, 0, 5),
        expected: '2026-01-16 00:00:00.005',
        withMs: true,
      },
      {
        // cross-year, month/day zero padding
        now: localTs(2026, 0, 1, 0, 0, 0),
        ts: localTs(2025, 11, 31, 23, 59, 59),
        expected: '2025-12-31 23:59:59',
      },
      {
        // month is 0-indexed: March must be 03, not 02
        now: localTs(2026, 2, 5, 12, 0, 0),
        ts: localTs(2026, 2, 4, 8, 9, 10),
        expected: '2026-03-04 08:09:10',
      },
    ];

    for (const item of cases) {
      expect(formatTimestamp(item.ts, { now: item.now, withMs: item.withMs })).toBe(item.expected);
    }
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;

  test('returns null for missing or invalid timestamps', () => {
    expect(relativeTime(undefined, now)).toBeNull();
    expect(relativeTime(Number.NaN, now)).toBeNull();
  });

  test('sub-minute and future timestamps fall back to just now', () => {
    expect(relativeTime(now - 59_999, now)).toEqual({ key: 'time.justNow' });
    expect(relativeTime(now + 1, now)).toEqual({ key: 'time.justNow' });
  });

  test('splits elapsed time into minutes, hours and days', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({
      key: 'time.minutesAgo',
      params: { count: 5 },
    });
    expect(relativeTime(now - 60 * 60_000, now)).toEqual({
      key: 'time.hoursAgo',
      params: { count: 1 },
    });
    expect(relativeTime(now - (60 + 14) * 60_000, now)).toEqual({
      key: 'time.hoursMinutesAgo',
      params: { count: 1, minutes: 14 },
    });
    expect(relativeTime(now - 3 * 86_400_000, now)).toEqual({
      key: 'time.daysAgo',
      params: { count: 3 },
    });
  });
});

describe('formatTokenCount', () => {
  test('keeps sub-thousand values raw and abbreviates larger ones', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_000)).toBe('1K');
    expect(formatTokenCount(784_400)).toBe('784.4K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
  });

  test('returns an empty string for invalid values', () => {
    expect(formatTokenCount(Number.NaN)).toBe('');
    expect(formatTokenCount(-1)).toBe('');
  });
});
