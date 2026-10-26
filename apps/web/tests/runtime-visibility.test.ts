import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RUNTIME_VISIBILITY,
  isRuntimeMessageVisible,
  loadRuntimeVisibility,
  parseRuntimeVisibility,
  RUNTIME_MESSAGE_KINDS,
  RUNTIME_VISIBILITY_STORAGE_KEY,
  type RuntimeVisibility,
  runtimeMessageKind,
  saveRuntimeVisibility,
} from '../src/state/runtime-visibility';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function visibility(overrides: Partial<RuntimeVisibility> = {}): RuntimeVisibility {
  return { ...DEFAULT_RUNTIME_VISIBILITY, ...overrides };
}

describe('runtimeMessageKind', () => {
  test('maps known vessel:* kinds', () => {
    expect(runtimeMessageKind({ name: 'vessel:source' })).toBe('source');
    expect(runtimeMessageKind({ name: 'vessel:notice' })).toBe('notice');
    expect(runtimeMessageKind({ name: 'vessel:subscription' })).toBe('subscription');
    expect(runtimeMessageKind({ name: 'vessel:limit' })).toBe('limit');
    expect(runtimeMessageKind({ name: 'vessel:compaction' })).toBe('compaction');
  });

  test('unknown vessel:* names fall back to other', () => {
    expect(runtimeMessageKind({ name: 'vessel:future-kind' })).toBe('other');
    expect(runtimeMessageKind({ name: 'vessel:' })).toBe('other');
    expect(runtimeMessageKind({ name: 'vessel:SOURCE' })).toBe('other');
  });

  test('non-runtime and missing names are not context messages', () => {
    expect(runtimeMessageKind({})).toBeUndefined();
    expect(runtimeMessageKind({ name: undefined })).toBeUndefined();
    expect(runtimeMessageKind({ name: 'source' })).toBeUndefined();
    expect(runtimeMessageKind({ name: 'user' })).toBeUndefined();
    expect(runtimeMessageKind({ name: '' })).toBeUndefined();
  });
});

describe('runtime visibility defaults', () => {
  test('every kind is hidden by default', () => {
    expect(Object.keys(DEFAULT_RUNTIME_VISIBILITY).sort()).toEqual(
      [...RUNTIME_MESSAGE_KINDS].sort(),
    );
    for (const kind of RUNTIME_MESSAGE_KINDS) {
      expect(DEFAULT_RUNTIME_VISIBILITY[kind]).toBe(false);
    }
  });

  test('storage key is stable', () => {
    expect(RUNTIME_VISIBILITY_STORAGE_KEY).toBe('vessel.web.runtimeContext');
  });
});

describe('load / save', () => {
  test('missing storage or missing value returns defaults', () => {
    expect(loadRuntimeVisibility(null)).toEqual(DEFAULT_RUNTIME_VISIBILITY);
    expect(loadRuntimeVisibility(fakeStorage())).toEqual(DEFAULT_RUNTIME_VISIBILITY);
  });

  test('malformed JSON returns defaults', () => {
    const storage = fakeStorage({ [RUNTIME_VISIBILITY_STORAGE_KEY]: '{not json' });
    expect(loadRuntimeVisibility(storage)).toEqual(DEFAULT_RUNTIME_VISIBILITY);
    expect(parseRuntimeVisibility('null')).toEqual(DEFAULT_RUNTIME_VISIBILITY);
    expect(parseRuntimeVisibility('[]')).toEqual(DEFAULT_RUNTIME_VISIBILITY);
    expect(parseRuntimeVisibility('')).toEqual(DEFAULT_RUNTIME_VISIBILITY);
  });

  test('unknown and non-boolean fields are ignored', () => {
    expect(parseRuntimeVisibility('{"source":true,"bogus":true}')).toEqual(
      visibility({ source: true }),
    );
    expect(parseRuntimeVisibility('{"source":"yes"}')).toEqual(DEFAULT_RUNTIME_VISIBILITY);
  });

  test('save then load round-trips under the local key', () => {
    const storage = fakeStorage();
    const next = visibility({ source: true, other: true });
    saveRuntimeVisibility(next, storage);
    expect(storage.store.get(RUNTIME_VISIBILITY_STORAGE_KEY)).toBe(JSON.stringify(next));
    expect(loadRuntimeVisibility(storage)).toEqual(next);
  });

  test('throwing storage does not propagate', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadRuntimeVisibility(storage)).toEqual(DEFAULT_RUNTIME_VISIBILITY);
    expect(() => saveRuntimeVisibility(visibility(), storage)).not.toThrow();
  });
});

describe('isRuntimeMessageVisible', () => {
  test('non-runtime messages are always visible', () => {
    expect(isRuntimeMessageVisible(visibility(), 'assistant')).toBe(true);
    expect(isRuntimeMessageVisible(visibility(), '')).toBe(true);
  });

  test('runtime kinds follow the per-kind setting', () => {
    expect(isRuntimeMessageVisible(visibility(), 'vessel:source')).toBe(false);
    expect(isRuntimeMessageVisible(visibility({ source: true }), 'vessel:source')).toBe(true);
    expect(isRuntimeMessageVisible(visibility({ source: true }), 'vessel:limit')).toBe(false);
  });

  test('unknown vessel:* names use the other toggle', () => {
    expect(isRuntimeMessageVisible(visibility(), 'vessel:future')).toBe(false);
    expect(isRuntimeMessageVisible(visibility({ other: true }), 'vessel:future')).toBe(true);
  });

  test('accepts a kind directly', () => {
    expect(isRuntimeMessageVisible(visibility({ notice: true }), 'notice')).toBe(true);
  });
});
