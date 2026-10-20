import { describe, expect, it } from 'bun:test';
import { formatClock, localDayKey, localDayLabel } from '../src/format';
import type { SessionInfo } from '../src/gateway/types';
import { groupSessionsByDay } from '../src/state/sessions';

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function session(id: string, updatedAt: number): SessionInfo {
  return {
    session_id: id,
    title: id,
    preview: '',
    status: 'completed',
    started_at: updatedAt,
    updated_at: updatedAt,
    message_count: 1,
  };
}

describe('local day helpers', () => {
  it('labels today/yesterday and formats clock time', () => {
    expect(localDayLabel(NOW, NOW)).toBe('今天');
    expect(localDayLabel(NOW - DAY, NOW)).toBe('昨天');
    expect(localDayLabel(NOW - 3 * DAY, NOW)).toBe('2026-10-16');
    expect(localDayKey(NOW)).toBe('2026-10-19');
    expect(formatClock(new Date(2026, 9, 19, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(undefined)).toBe('');
    expect(formatClock(Number.NaN)).toBe('');
  });
});

describe('groupSessionsByDay', () => {
  it('groups contiguous sessions by local day, preserving order', () => {
    const groups = groupSessionsByDay(
      [
        session('a', NOW),
        session('b', NOW - 60_000),
        session('c', NOW - DAY),
        session('d', NOW - 3 * DAY),
      ],
      NOW,
    );
    expect(groups.map((group) => group.label)).toEqual(['今天', '昨天', '2026-10-16']);
    expect(groups.map((group) => group.sessions.map((item) => item.session_id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupSessionsByDay([], NOW)).toEqual([]);
  });

  it('degrades invalid timestamps to an empty key/label', () => {
    const groups = groupSessionsByDay([session('bad', Number.NaN)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('');
    expect(groups[0]?.label).toBe('');
  });
});
