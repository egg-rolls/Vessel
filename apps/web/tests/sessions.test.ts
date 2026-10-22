import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '../src/gateway/types';
import {
  filterSessions,
  MAX_SESSION_TITLE,
  normalizeSessionTitle,
  removeSessionFromList,
  renameSessionInList,
  selectionAfterDelete,
  sessionTitle,
  sortSessions,
  takeSessions,
} from '../src/state/sessions';

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: id,
    title: `title ${id}`,
    preview: `preview ${id}`,
    status: 'completed',
    started_at: 1,
    updated_at: 1,
    message_count: 1,
    ...overrides,
  };
}

describe('sortSessions', () => {
  test('orders by updated_at desc and session_id asc on ties', () => {
    const list = [
      session('b', { updated_at: 10 }),
      session('c', { updated_at: 20 }),
      session('a', { updated_at: 20 }),
    ];
    expect(sortSessions(list).map((item) => item.session_id)).toEqual(['a', 'c', 'b']);
  });

  test('does not mutate the input', () => {
    const list = [session('b', { updated_at: 1 }), session('a', { updated_at: 2 })];
    const copy = [...list];
    sortSessions(list);
    expect(list).toEqual(copy);
  });
});

describe('normalizeSessionTitle', () => {
  test('trims valid titles', () => {
    expect(normalizeSessionTitle('  hello  ')).toBe('hello');
  });

  test('rejects blank and over-long titles', () => {
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('')).toBeNull();
    expect(normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE + 1))).toBeNull();
    expect(normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE))).not.toBeNull();
  });
});

describe('filterSessions', () => {
  const list = [
    session('a', { title: 'Fix gateway', preview: 'reconnect', status: 'running' }),
    session('b', { title: 'MCP research', preview: 'servers', status: 'failed' }),
    session('c', { title: 'Eval smoke', preview: 'checks', status: 'completed' }),
  ];

  test('matches title, preview and id case-insensitively', () => {
    expect(filterSessions(list, { query: 'GATEWAY' }).map((s) => s.session_id)).toEqual(['a']);
    expect(filterSessions(list, { query: 'recon' }).map((s) => s.session_id)).toEqual(['a']);
    expect(filterSessions(list, { query: 'c' }).map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
  });

  test('empty query keeps everything', () => {
    expect(filterSessions(list, {})).toHaveLength(3);
  });
});

describe('takeSessions', () => {
  const list = [session('a'), session('b'), session('c')];

  test('windows and reports hidden count', () => {
    expect(takeSessions(list, 2)).toEqual({ shown: list.slice(0, 2), hiddenCount: 1 });
    expect(takeSessions(list, 10)).toEqual({ shown: list, hiddenCount: 0 });
    expect(takeSessions(list, 0)).toEqual({ shown: [], hiddenCount: 3 });
  });
});

describe('list updates', () => {
  test('renames and removes without mutating', () => {
    const list = [session('a'), session('b')];
    const renamed = renameSessionInList(list, 'b', 'new title');
    expect(renamed.find((s) => s.session_id === 'b')?.title).toBe('new title');
    expect(list.find((s) => s.session_id === 'b')?.title).toBe('title b');
    expect(removeSessionFromList(list, 'a').map((s) => s.session_id)).toEqual(['b']);
  });

  test('selectionAfterDelete clears a deleted selection or draft', () => {
    expect(selectionAfterDelete('a', null, 'a')).toEqual({ selectedId: null, draftId: null });
    expect(selectionAfterDelete(null, 'draft', 'draft')).toEqual({
      selectedId: null,
      draftId: null,
    });
    expect(selectionAfterDelete('a', null, 'b')).toEqual({ selectedId: 'a', draftId: null });
  });

  test('sessionTitle falls back to preview then id', () => {
    expect(sessionTitle(session('a', { title: '' }))).toBe('preview a');
    expect(sessionTitle(session('a', { title: '', preview: '' }))).toBe('a');
  });
});
