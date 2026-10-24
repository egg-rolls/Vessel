import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageToggle, toggleLocale } from '../src/app/LanguageToggle';
import { getLocale, setLocale } from '../src/i18n';

afterAll(() => setLocale('zh-CN'));

describe('AppBar language toggle', () => {
  test('flips both supported locales in both directions', () => {
    setLocale('zh-CN');
    expect(toggleLocale(getLocale())).toBe('en');
    setLocale(toggleLocale(getLocale()));
    expect(getLocale()).toBe('en');
    setLocale(toggleLocale(getLocale()));
    expect(getLocale()).toBe('zh-CN');
  });

  test('renders the target language and localized aria-label', () => {
    setLocale('zh-CN');
    const zhMarkup = renderToStaticMarkup(<LanguageToggle />);
    expect(zhMarkup).toContain('>EN<');
    expect(zhMarkup).toContain('aria-label="切换界面语言为 English"');

    setLocale('en');
    const enMarkup = renderToStaticMarkup(<LanguageToggle />);
    expect(enMarkup).toContain('>中文<');
    expect(enMarkup).toContain('aria-label="Switch interface language to 简体中文"');
    expect(enMarkup).not.toContain('切换界面语言为');
  });
});
