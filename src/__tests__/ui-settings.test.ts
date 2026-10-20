import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createReplSettings, setUserLanguage, type UiLanguage } from '../ui-settings';

describe('ui-settings（0.11 DECISION-021 §3.2）', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-settings-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readRoot(): Record<string, unknown> {
    return parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('写入 ui.language 并保留其它根键与 ui 其它键', async () => {
    fs.writeFileSync(
      configPath,
      [
        'api_key: sk-test',
        'provider:',
        '  model: gpt-4',
        'ui:',
        '  clear_on_start: false',
        '',
      ].join('\n'),
      'utf-8',
    );

    await setUserLanguage('en', { configPath });

    const root = readRoot();
    expect(root.api_key).toBe('sk-test');
    expect(root.provider).toEqual({ model: 'gpt-4' });
    expect(root.ui).toEqual({ clear_on_start: false, language: 'en' });
  });

  it('文件不存在时创建', async () => {
    await setUserLanguage('zh-CN', { configPath });
    expect(readRoot().ui).toEqual({ language: 'zh-CN' });
  });

  it('幂等：重复写入相同语言内容不变', async () => {
    await setUserLanguage('en', { configPath });
    const first = fs.readFileSync(configPath, 'utf-8');
    await setUserLanguage('en', { configPath });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(first);
  });

  it('POSIX 上文件权限为 0600', async () => {
    if (process.platform === 'win32') return;
    await setUserLanguage('en', { configPath });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('非法语言显式失败且不写文件', async () => {
    await expect(setUserLanguage('fr' as unknown as UiLanguage, { configPath })).rejects.toThrow(
      'invalid_language',
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('根不是对象或 ui 不是对象时显式失败', async () => {
    fs.writeFileSync(configPath, '- just\n- a\n- list\n', 'utf-8');
    await expect(setUserLanguage('en', { configPath })).rejects.toThrow(
      'ui_settings_invalid_config',
    );

    fs.writeFileSync(configPath, 'ui: nope\n', 'utf-8');
    await expect(setUserLanguage('en', { configPath })).rejects.toThrow(
      'ui_settings_invalid_config',
    );
  });

  it('createReplSettings 使用 resolveLocale 优先级并绑定写入路径', async () => {
    const settings = createReplSettings({
      configPath,
      env: { VESSEL_LANG: 'en-US' },
      configLanguage: 'zh-CN',
    });
    expect(settings.language).toBe('en');
    expect(typeof settings.setLanguage).toBe('function');

    await settings.setLanguage('zh-CN');
    expect(readRoot().ui).toEqual({ language: 'zh-CN' });
  });

  it('createReplSettings 无 VESSEL_LANG 时使用 configLanguage', () => {
    const settings = createReplSettings({
      configPath,
      env: {},
      configLanguage: 'en',
    });
    expect(settings.language).toBe('en');
  });
});
