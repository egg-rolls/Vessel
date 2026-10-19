import { describe, expect, test } from 'bun:test';
import { formatTimestamp } from '../src/format';

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
