import { afterEach, describe, expect, it } from 'bun:test';
import { getLocale, resolveLocale, setLocale } from '../src/i18n/index.js';
import { en } from '../src/i18n/messages/en.js';
import { zhCN } from '../src/i18n/messages/zh-CN.js';

afterEach(() => {
  setLocale('zh-CN');
});

describe('catalog key parity', () => {
  it('en catalog is missing no zh-CN key and adds no unknown key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });
});

describe('resolveLocale', () => {
  it('env tag wins over config and LANG; LANG_zh_CN.UTF-8 normalizes to zh-CN', () => {
    const env = { VESSEL_LANG: 'en-US', LANG: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' };
    expect(resolveLocale({ env, configLanguage: 'zh-CN' })).toBe('en');
    expect(resolveLocale({ env: { LANG: 'zh_CN.UTF-8' } })).toBe('zh-CN');
    expect(resolveLocale({ env: { LC_ALL: 'en_GB.UTF-8' } })).toBe('en');
  });

  it('invalid VESSEL_LANG skips to config, then LANG, then default zh-CN', () => {
    expect(resolveLocale({ env: { VESSEL_LANG: 'fr-FR' }, configLanguage: 'en' })).toBe('en');
    expect(resolveLocale({ env: { VESSEL_LANG: 'fr-FR' }, configLanguage: 'fr' })).toBe('zh-CN');
    expect(resolveLocale({ env: { VESSEL_LANG: '  ' }, configLanguage: 'zh_CN' })).toBe('zh-CN');
    expect(resolveLocale({ env: {} })).toBe('zh-CN');
    expect(getLocale()).toBe('zh-CN');
  });
});
