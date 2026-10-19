import { describe, expect, test } from 'bun:test';
import {
  applyTheme,
  normalizeTheme,
  readStoredTheme,
  storeTheme,
  type Theme,
  themeAttribute,
} from '../src/state/theme';

describe('normalizeTheme', () => {
  test('accepts light/dark and falls back to system', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('banana')).toBe('system');
    expect(normalizeTheme(null)).toBe('system');
  });

  test('system removes the data-theme attribute', () => {
    expect(themeAttribute('system')).toBeNull();
    expect(themeAttribute('dark')).toBe('dark');
    expect(themeAttribute('light')).toBe('light');
  });
});

describe('applyTheme', () => {
  test('sets and removes data-theme on the root', () => {
    const root = {
      dataset: {} as Record<string, string>,
      removeAttribute(name: string) {
        if (name === 'data-theme') delete this.dataset.theme;
      },
    };
    applyTheme('dark' as Theme, root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light' as Theme, root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system' as Theme, root);
    expect(root.dataset.theme).toBeUndefined();
  });
});

describe('storage helpers', () => {
  test('readStoredTheme tolerates invalid values and storage errors', () => {
    expect(readStoredTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(readStoredTheme({ getItem: () => 'nope' })).toBe('system');
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
  });

  test('storeTheme swallows quota errors', () => {
    let stored: string | null = null;
    storeTheme('dark', {
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    });
    expect(stored).toBe('dark');
    expect(() =>
      storeTheme('dark', {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});
