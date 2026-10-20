import { afterEach, describe, expect, test } from 'bun:test';
import {
  getLocale,
  LOCALE_STORAGE_KEY,
  parseLocale,
  resolveLocale,
  setLocale,
  subscribeLocale,
  t,
} from '../src/i18n';
import { messages as en } from '../src/i18n/messages/en';
import { messages as zhCN } from '../src/i18n/messages/zh-CN';

const ENV_STORAGE = 'localStorage' as const;

function installFakeStorage() {
  const store = new Map<string, string>();
  const previous = (globalThis as Record<string, unknown>)[ENV_STORAGE];
  (globalThis as Record<string, unknown>)[ENV_STORAGE] = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return {
    store,
    restore() {
      if (previous === undefined) delete (globalThis as Record<string, unknown>)[ENV_STORAGE];
      else (globalThis as Record<string, unknown>)[ENV_STORAGE] = previous;
    },
  };
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('parseLocale / resolveLocale', () => {
  test('normalizes supported language tags and rejects unknown ones', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('EN-us')).toBe('en');
    expect(parseLocale('en_US')).toBe('en');
    expect(parseLocale('zh')).toBe('zh-CN');
    expect(parseLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(parseLocale('fr-FR')).toBeNull();
    expect(parseLocale('')).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocale(undefined)).toBeNull();
  });

  test('stored preference wins over navigator.language', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  test('falls back to navigator.language and then zh-CN', () => {
    expect(resolveLocale(null, 'en-US')).toBe('en');
    expect(resolveLocale(null, 'en')).toBe('en');
    expect(resolveLocale(null, 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale(null, 'fr-FR')).toBe('zh-CN');
    expect(resolveLocale(undefined, undefined)).toBe('zh-CN');
  });

  test('ignores an invalid stored value and still uses navigator.language', () => {
    expect(resolveLocale('banana', 'en-GB')).toBe('en');
  });
});

describe('catalogs', () => {
  test('zh-CN and en expose exactly the same key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  test('every covered message is a non-empty string', () => {
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(typeof zhCN[key]).toBe('string');
      expect(zhCN[key].trim().length).toBeGreaterThan(0);
      expect(en[key].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('t()', () => {
  test('translates covered keys per current locale', () => {
    setLocale('zh-CN');
    expect(t('nav.domain.chat')).toBe('会话');
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('nav.domain.chat')).toBe('Sessions');
    expect(t('settings.tab.appearance')).toBe('Appearance');
  });

  test('interpolates params and leaves unknown placeholders untouched', () => {
    setLocale('en');
    expect(t('breadcrumb.runs.detail', { tab: 'Live' })).toBe('Runs › Live');
    expect(t('nav.tenantNamed', { tenant: 'default' })).toBe('Tenant default');
    expect(t('breadcrumb.runs.detail', { other: 'x' })).toBe('Runs › {tab}');
  });

  test('falls back to the key when no catalog has it', () => {
    expect(t('missing.key')).toBe('missing.key');
  });
});

describe('setLocale persistence and subscriptions', () => {
  test('writes the locale to vessel.ui.language', () => {
    const fake = installFakeStorage();
    try {
      setLocale('zh-CN');
      setLocale('en');
      expect(fake.store.get(LOCALE_STORAGE_KEY)).toBe('en');
      setLocale('zh-CN');
      expect(fake.store.get(LOCALE_STORAGE_KEY)).toBe('zh-CN');
      // 重复选择同一语言也要落盘（可能只是 navigator 推导出的当前值）。
      fake.store.clear();
      setLocale('zh-CN');
      expect(fake.store.get(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    } finally {
      fake.restore();
    }
  });

  test('notifies subscribers once per real change and supports unsubscribe', () => {
    setLocale('zh-CN');
    const seen: string[] = [];
    const unsubscribe = subscribeLocale(() => seen.push(getLocale()));
    setLocale('en');
    setLocale('en');
    expect(seen).toEqual(['en']);
    unsubscribe();
    setLocale('zh-CN');
    expect(seen).toEqual(['en']);
  });
});
