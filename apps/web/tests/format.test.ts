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
    expect(formatTimestamp(undefined, { now: localTs(2026, 0, 15), withMs: true })).toBe('');
  });

  test('same day renders HH:MM:SS', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 15, 9, 5, 7);

    expect(formatTimestamp(ts, { now })).toBe('09:05:07');
  });

  test('same day with withMs renders HH:MM:SS.mmm', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 15, 9, 5, 7, 42);

    expect(formatTimestamp(ts, { now, withMs: true })).toBe('09:05:07.042');
  });

  test('same day with withMs false has no milliseconds', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 15, 9, 5, 7, 999);

    expect(formatTimestamp(ts, { now, withMs: false })).toBe('09:05:07');
  });

  test('pads hours, minutes, seconds and milliseconds', () => {
    const now = localTs(2026, 0, 15, 23, 0, 0);
    const ts = localTs(2026, 0, 15, 0, 0, 3, 7);

    expect(formatTimestamp(ts, { now })).toBe('00:00:03');
    expect(formatTimestamp(ts, { now, withMs: true })).toBe('00:00:03.007');
  });

  test('previous day renders YYYY-MM-DD HH:MM:SS', () => {
    const now = localTs(2026, 0, 15, 0, 0, 1);
    const ts = localTs(2026, 0, 14, 23, 59, 59);

    expect(formatTimestamp(ts, { now })).toBe('2026-01-14 23:59:59');
  });

  test('next day renders the full date too', () => {
    const now = localTs(2026, 0, 15, 23, 59, 59);
    const ts = localTs(2026, 0, 16, 0, 0, 0, 5);

    expect(formatTimestamp(ts, { now, withMs: true })).toBe('2026-01-16 00:00:00.005');
  });

  test('cross-year renders the full date and year', () => {
    const now = localTs(2026, 0, 1, 0, 0, 0);
    const ts = localTs(2025, 11, 31, 23, 59, 59);

    expect(formatTimestamp(ts, { now })).toBe('2025-12-31 23:59:59');
    expect(formatTimestamp(ts, { now, withMs: true })).toBe('2025-12-31 23:59:59.000');
  });

  test('pads month and day', () => {
    const now = localTs(2026, 2, 5, 12, 0, 0);
    const ts = localTs(2026, 2, 4, 8, 9, 10);

    expect(formatTimestamp(ts, { now })).toBe('2026-03-04 08:09:10');
  });
});
