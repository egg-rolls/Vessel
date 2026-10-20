import { afterEach, describe, expect, it } from 'bun:test';
import { createCommands } from '../src/commands/commands.js';
import { getLocale, setLocale } from '../src/i18n/index.js';
import { makeCtx, makeState } from './helpers.js';

afterEach(() => {
  setLocale('zh-CN');
});

function run(args: string, ctx = makeCtx()) {
  return createCommands().execute(
    `settings${args ? ` ${args}` : ''}`,
    ctx,
    makeState(ctx.currentSessionId),
  );
}

describe('/settings', () => {
  it('未注入 settings 时显示当前语言与只读提示', async () => {
    setLocale('zh-CN');
    const result = await run('');

    expect(result.handled).toBe(true);
    expect(result.output).toContain('zh-CN');
    expect(result.output).toContain('/settings');
    expect(result.localeChanged).toBeUndefined();
  });

  it('切换语言先调用 setLanguage，成功后 locale 立即变化', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      settings: {
        language: 'zh-CN',
        setLanguage: async (locale) => {
          calls.push(locale);
        },
      },
    });

    const result = await run('language en', ctx);

    expect(calls).toEqual(['en']);
    expect(getLocale()).toBe('en');
    expect(result.localeChanged).toBe(true);
    expect(result.output).toContain('en');
  });

  it('写失败时显示错误且不切换 locale', async () => {
    const ctx = makeCtx({
      settings: {
        language: 'zh-CN',
        setLanguage: async () => {
          throw new Error('disk read-only');
        },
      },
    });

    const result = await run('language en', ctx);

    expect(getLocale()).toBe('zh-CN');
    expect(result.localeChanged).toBeUndefined();
    expect(result.output).toContain('Failed to save language setting');
  });

  it('非法语言不调用 setLanguage', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      settings: {
        language: 'zh-CN',
        setLanguage: async (locale) => {
          calls.push(locale);
        },
      },
    });

    const result = await run('language fr', ctx);

    expect(calls).toEqual([]);
    expect(result.output).toContain('fr');
    expect(getLocale()).toBe('zh-CN');
  });

  it('未注入时切换请求不改变 locale', async () => {
    setLocale('zh-CN');
    const result = await run('language en');

    expect(getLocale()).toBe('zh-CN');
    expect(result.localeChanged).toBeUndefined();
    expect(result.output).toContain('/settings');
  });
});
