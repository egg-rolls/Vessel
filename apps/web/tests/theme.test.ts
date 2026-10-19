import { describe, expect, test } from 'bun:test';
import {
  applyTheme,
  initialTheme,
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

describe('initialTheme', () => {
  test('defaults to dark only when no valid preference is stored', () => {
    expect(initialTheme(null)).toBe('dark');
    expect(initialTheme(undefined)).toBe('dark');
    expect(initialTheme('banana')).toBe('dark');
    expect(initialTheme('system')).toBe('system');
    expect(initialTheme('light')).toBe('light');
    expect(initialTheme('dark')).toBe('dark');
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
  test('readStoredTheme falls back to dark when the preference is absent or unreadable', () => {
    expect(readStoredTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(readStoredTheme({ getItem: () => 'system' })).toBe('system');
    expect(readStoredTheme({ getItem: () => 'nope' })).toBe('dark');
    expect(readStoredTheme({ getItem: () => null })).toBe('dark');
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('dark');
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
