import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/loader';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingUserConfig(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ui-')), 'missing.yaml');
}

describe('ui 配置', () => {
  it('配置文件含 ui.language 时不被当作未知键拒绝', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  language: en\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui?.language).toBe('en');
  });

  it('ui.clear_on_start 映射为 clearOnStart 并接受布尔值', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  language: zh-CN\n  clear_on_start: false\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui).toEqual({ language: 'zh-CN', clearOnStart: false });
  });

  it('clearOnStart 非布尔时报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  clear_on_start: nope\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.map((error) => error.path)).toContain('ui.clearOnStart');
  });

  it('ui 非对象时报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui: nope\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors.map((error) => error.path)).toContain('ui');
  });

  it('ui 未知键仍报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  clear_on_start: true\n  nope: 1\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors.map((error) => error.path)).toContain('ui.nope');
  });

  it('ui.language 非字符串时报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  language: 1\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors.map((error) => error.path)).toContain('ui.language');
  });

  it('ui.status_bars 映射为 statusBars 并接受枚举（0.13）', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  status_bars: bottom\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui).toEqual({ statusBars: 'bottom' });
  });

  it('ui.statusBars camelCase 也能直接加载（0.13）', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  statusBars: top\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui?.statusBars).toBe('top');
  });

  it('ui.statusBars 非法枚举时报错（0.13）', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  status_bars: side\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.map((error) => error.path)).toContain('ui.statusBars');
  });
});
