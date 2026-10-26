import { beforeEach, describe, expect, test } from 'bun:test';
import { storeTheme, THEME_KEY } from '../src/state/theme';
import {
  DEFAULT_RUNTIME_VISIBILITY,
  DISPLAY_VALUES_STORAGE_KEY,
  loadDisplayValues,
  loadUiPreferences,
  parseDisplayValues,
  RUNTIME_VISIBILITY_STORAGE_KEY,
  saveDisplayValues,
  useUiStore,
} from '../src/stores/uiStore';

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

function resetStore(): void {
  useUiStore.setState(loadUiPreferences(null));
}

function defaults() {
  return {
    theme: 'dark' as const,
    display: {},
    runtimeVisibility: { ...DEFAULT_RUNTIME_VISIBILITY },
    verbosity: 'normal' as const,
    errorLevel: 'user' as const,
  };
}

describe('uiStore hydration', () => {
  test('missing storage uses defaults', () => {
    expect(loadUiPreferences(null)).toEqual(defaults());
  });

  test('malformed values fall back to defaults', () => {
    const storage = fakeStorage({
      [THEME_KEY]: 'banana',
      [RUNTIME_VISIBILITY_STORAGE_KEY]: '{not json',
      [DISPLAY_VALUES_STORAGE_KEY]: '[1,2]',
    });
    expect(loadUiPreferences(storage)).toEqual(defaults());
  });

  test('reads valid values and ignores unknown/invalid fields', () => {
    const storage = fakeStorage({
      [THEME_KEY]: 'light',
      [RUNTIME_VISIBILITY_STORAGE_KEY]: '{"source":true,"bogus":true,"notice":"yes"}',
      [DISPLAY_VALUES_STORAGE_KEY]:
        '{"ui.verbosity":"debug","ui.errorLevel":"all","ui.askUser":"maybe","provider.apiKey":"secret","extra":""}',
    });
    const state = loadUiPreferences(storage);
    expect(state.theme).toBe('light');
    expect(state.runtimeVisibility.source).toBe(true);
    expect(state.runtimeVisibility.notice).toBe(false);
    expect(state.display).toEqual({ 'ui.verbosity': 'debug', 'ui.errorLevel': 'all' });
    expect(state.verbosity).toBe('debug');
    expect(state.errorLevel).toBe('all');
  });

  test('blocked storage falls back without throwing', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadUiPreferences(storage)).toEqual(defaults());
  });
});

describe('uiStore setters', () => {
  beforeEach(resetStore);

  test('setTheme updates the shared theme preference', () => {
    useUiStore.getState().setTheme('light');
    expect(useUiStore.getState().theme).toBe('light');
  });

  test('setDisplay mirrors verbosity and errorLevel', () => {
    useUiStore.getState().setDisplay({ 'ui.verbosity': 'minimal', 'ui.errorLevel': 'all' });
    expect(useUiStore.getState().display).toEqual({
      'ui.verbosity': 'minimal',
      'ui.errorLevel': 'all',
    });
    expect(useUiStore.getState().verbosity).toBe('minimal');
    expect(useUiStore.getState().errorLevel).toBe('all');

    useUiStore.getState().setVerbosity('debug');
    expect(useUiStore.getState().display['ui.verbosity']).toBe('debug');
    expect(useUiStore.getState().verbosity).toBe('debug');

    useUiStore.getState().setErrorLevel('user');
    expect(useUiStore.getState().display['ui.errorLevel']).toBe('user');
    expect(useUiStore.getState().errorLevel).toBe('user');
  });

  test('setDisplay drops unknown keys and invalid values', () => {
    useUiStore
      .getState()
      .setDisplay({ 'ui.verbosity': 'loud', 'provider.apiKey': 'secret', 'ui.askUser': 'maybe' });
    expect(useUiStore.getState().display).toEqual({});
    expect(useUiStore.getState().verbosity).toBe('normal');
  });

  test('runtime visibility setters replace the whole slice', () => {
    useUiStore.getState().setRuntimeKind('notice', true);
    expect(useUiStore.getState().runtimeVisibility.notice).toBe(true);
    expect(useUiStore.getState().runtimeVisibility.source).toBe(false);

    useUiStore.getState().setAllRuntimeKinds(true);
    for (const kind of [
      'source',
      'notice',
      'subscription',
      'limit',
      'compaction',
      'other',
    ] as const) {
      expect(useUiStore.getState().runtimeVisibility[kind]).toBe(true);
    }

    useUiStore.getState().setAllRuntimeKinds(false);
    for (const kind of [
      'source',
      'notice',
      'subscription',
      'limit',
      'compaction',
      'other',
    ] as const) {
      expect(useUiStore.getState().runtimeVisibility[kind]).toBe(false);
    }
  });
});

describe('theme storage', () => {
  test('storeTheme writes the existing key and syncs the shared store', () => {
    resetStore();
    const storage = fakeStorage();
    storeTheme('light', storage);
    expect(storage.store.get(THEME_KEY)).toBe('light');
    expect(useUiStore.getState().theme).toBe('light');
  });
});

describe('display storage helpers', () => {
  test('save then load round-trips under the local key', () => {
    const storage = fakeStorage();
    saveDisplayValues({ 'ui.verbosity': 'debug', 'ui.askUser': 'true' }, storage);
    expect(storage.store.get(DISPLAY_VALUES_STORAGE_KEY)).toBe(
      JSON.stringify({ 'ui.verbosity': 'debug', 'ui.askUser': 'true' }),
    );
    expect(loadDisplayValues(storage)).toEqual({
      'ui.verbosity': 'debug',
      'ui.askUser': 'true',
    });
  });

  test('malformed JSON returns an empty map', () => {
    expect(parseDisplayValues('{not json')).toEqual({});
    expect(parseDisplayValues('null')).toEqual({});
    expect(parseDisplayValues('')).toEqual({});
    expect(loadDisplayValues(fakeStorage({ [DISPLAY_VALUES_STORAGE_KEY]: '[]' }))).toEqual({});
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
    expect(loadDisplayValues(storage)).toEqual({});
    expect(() => saveDisplayValues({ 'ui.verbosity': 'debug' }, storage)).not.toThrow();
  });
});
