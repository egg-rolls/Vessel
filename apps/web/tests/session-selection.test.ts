import { describe, expect, test } from 'bun:test';
import {
  clearLastSession,
  decideSessionRestore,
  LAST_SESSION_KEY_PREFIX,
  lastSessionKey,
  readLastSession,
  writeLastSession,
} from '../src/domains/chat/session-selection';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('decideSessionRestore', () => {
  test('restores a recorded session only when it is in the tenant session list', () => {
    expect(
      decideSessionRestore({
        storedSessionId: 'ses-1',
        knownSessionIds: ['ses-1', 'ses-2'],
      }),
    ).toEqual({ kind: 'restore', sessionId: 'ses-1' });

    expect(
      decideSessionRestore({
        storedSessionId: 'ses-deleted',
        knownSessionIds: ['ses-1', 'ses-2'],
      }),
    ).toEqual({ kind: 'new', clear: true });
  });

  test('deep link wins over the recorded session', () => {
    expect(
      decideSessionRestore({
        routeSessionId: 'ses-deep',
        storedSessionId: 'ses-old',
        knownSessionIds: ['ses-deep', 'ses-old'],
      }),
    ).toEqual({ kind: 'keep' });

    expect(
      decideSessionRestore({
        routeSessionId: 'new',
        storedSessionId: 'ses-old',
        knownSessionIds: ['ses-old'],
      }),
    ).toEqual({ kind: 'keep' });
  });

  test('waits for the session list before discarding a recorded id', () => {
    expect(
      decideSessionRestore({
        storedSessionId: 'ses-1',
        knownSessionIds: null,
      }),
    ).toEqual({ kind: 'wait' });
  });

  test('records are isolated per tenant', () => {
    const storage = memoryStorage();
    expect(lastSessionKey('tenant-a')).toBe(`${LAST_SESSION_KEY_PREFIX}tenant-a`);
    expect(lastSessionKey(null)).toBe(`${LAST_SESSION_KEY_PREFIX}default`);
    expect(lastSessionKey('  ')).toBe(`${LAST_SESSION_KEY_PREFIX}default`);

    writeLastSession(storage, 'tenant-a', 'ses-a');
    expect(readLastSession(storage, 'tenant-a')).toBe('ses-a');
    expect(readLastSession(storage, 'tenant-b')).toBeNull();

    clearLastSession(storage, 'tenant-a');
    expect(readLastSession(storage, 'tenant-a')).toBeNull();
  });

  test('new tab without a record lands in the new-session state', () => {
    expect(
      decideSessionRestore({
        storedSessionId: null,
        knownSessionIds: [],
      }),
    ).toEqual({ kind: 'new', clear: false });
  });
});
