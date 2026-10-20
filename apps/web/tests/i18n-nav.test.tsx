import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { domainLabel, routeBreadcrumb, settingsTabLabel } from '../src/app/nav';
import { AppearanceView } from '../src/domains/settings/AppearanceView';
import { getLocale, setLocale, useLocale } from '../src/i18n';

/** 与壳层相同的最小消费方：订阅 locale 并在渲染期调用 t()。 */
function ShellProbe() {
  useLocale();
  return (
    <div>
      <span>{domainLabel('chat')}</span>
      <span>{domainLabel('runs')}</span>
      <span>{domainLabel('settings')}</span>
      <span>{routeBreadcrumb({ domain: 'settings', tab: 'appearance' })}</span>
      <span>{routeBreadcrumb({ domain: 'runs', tab: 'durable', runId: 'r1' })}</span>
      <span>{settingsTabLabel('capabilities')}</span>
    </div>
  );
}

function withFakeStorage(run: () => void): void {
  const previous = (globalThis as Record<string, unknown>).localStorage;
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  try {
    run();
  } finally {
    if (previous === undefined) delete (globalThis as Record<string, unknown>).localStorage;
    else (globalThis as Record<string, unknown>).localStorage = previous;
  }
}

afterAll(() => setLocale('zh-CN'));

describe('shell labels follow the selected locale', () => {
  test('renders zh-CN navigation and breadcrumb by default', () => {
    setLocale('zh-CN');
    const markup = renderToStaticMarkup(<ShellProbe />);
    expect(markup).toContain('会话');
    expect(markup).toContain('运行');
    expect(markup).toContain('设置 › 外观');
    expect(markup).toContain('运行 › 可恢复 › 详情');
    expect(markup).toContain('能力清单');
  });

  test('switching to en re-renders navigation and breadcrumb', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    const markup = renderToStaticMarkup(<ShellProbe />);
    expect(markup).toContain('Sessions');
    expect(markup).toContain('Runs');
    expect(markup).toContain('Settings › Appearance');
    expect(markup).toContain('Runs › Recoverable › Details');
    expect(markup).toContain('Capabilities');
    expect(markup).not.toContain('设置 › 外观');
  });
});

describe('Settings → Appearance language control', () => {
  test('offers both languages and follows the current locale', () => {
    withFakeStorage(() => {
      setLocale('zh-CN');
      const zhMarkup = renderToStaticMarkup(<AppearanceView />);
      expect(zhMarkup).toContain('界面语言');
      expect(zhMarkup).toContain('简体中文');
      expect(zhMarkup).toContain('English');

      setLocale('en');
      const enMarkup = renderToStaticMarkup(<AppearanceView />);
      expect(enMarkup).toContain('Language');
      expect(enMarkup).toContain('Theme');
      expect(enMarkup).toContain('English');
      expect(enMarkup).not.toContain('界面语言');
    });
  });
});
