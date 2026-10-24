import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { domainLabel, navGroupLabel, routeBreadcrumb, settingsTabLabel } from '../src/app/nav';
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
      <span>{domainLabel('agents')}</span>
      <span>{domainLabel('teams')}</span>
      <span>{domainLabel('nodes')}</span>
      <span>{domainLabel('hub')}</span>
      <span>{domainLabel('gateway')}</span>
      <span>{navGroupLabel('network')}</span>
      <span>{navGroupLabel('status')}</span>
      <span>{routeBreadcrumb({ domain: 'gateway' })}</span>
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
    expect(markup).toContain('智能体编排');
    expect(markup).toContain('状态');
    expect(markup).toContain('智能体');
    expect(markup).toContain('团队');
    expect(markup).toContain('面板核心');
    expect(markup).toContain('网关');
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
    expect(markup).toContain('ORCHESTRATION');
    expect(markup).toContain('STATUS');
    expect(markup).toContain('Agents');
    expect(markup).toContain('Teams');
    expect(markup).toContain('Nodes');
    expect(markup).toContain('Hub');
    expect(markup).toContain('Gateway');
    expect(markup).not.toContain('设置 › 外观');
    expect(markup).not.toContain('智能体编排');
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
