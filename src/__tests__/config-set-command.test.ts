import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from '../cli-args';
import { configSetCommand } from '../config-command';

describe('vessel config set（0.11）', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-config-set-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('解析 config set ui.language en', () => {
    const parsed = parseArgs(['config', 'set', 'ui.language', 'en']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.configCommand).toEqual({
      kind: 'set',
      key: 'ui.language',
      value: 'en',
      json: false,
    });
  });

  it('解析 --json 且拒绝非法键/非法语言/缺参', () => {
    const withJson = parseArgs(['config', 'set', 'ui.language', 'zh-CN', '--json']);
    expect(withJson.ok).toBe(true);
    if (withJson.ok) {
      expect(withJson.args.configCommand).toMatchObject({ json: true, value: 'zh-CN' });
    }

    expect(parseArgs(['config', 'set', 'ui.theme', 'en']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'ui.language', 'fr']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'ui.language']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'ui.language', 'en', '--force']).ok).toBe(false);
  });

  it('写入 ui.language 并保留其它键', async () => {
    fs.writeFileSync(configPath, 'api_key: sk-test\nprovider:\n  model: gpt-4\n', 'utf-8');

    const result = await configSetCommand('ui.language', 'en', { userConfigPath: configPath });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ui.language = en');
    const root = parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(root.api_key).toBe('sk-test');
    expect(root.provider).toEqual({ model: 'gpt-4' });
    expect(root.ui).toEqual({ language: 'en' });
  });

  it('--json 输出结构化结果', async () => {
    const result = await configSetCommand('ui.language', 'zh-CN', {
      userConfigPath: configPath,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: 'ui.language',
      value: 'zh-CN',
      path: configPath,
    });
  });

  it('非法键/非法语言返回 exit 2 且不写文件', async () => {
    const badKey = await configSetCommand('ui.theme', 'en', { userConfigPath: configPath });
    expect(badKey.exitCode).toBe(2);
    expect(badKey.stderr).toContain('ui.theme');
    expect(fs.existsSync(configPath)).toBe(false);

    const badValue = await configSetCommand('ui.language', 'fr', { userConfigPath: configPath });
    expect(badValue.exitCode).toBe(2);
    expect(badValue.stderr).toContain('zh-CN');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('写入失败返回 exit 1 与可读错误', async () => {
    const result = await configSetCommand('ui.language', 'en', { userConfigPath: dir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ui_settings_read_failed');
  });
});
