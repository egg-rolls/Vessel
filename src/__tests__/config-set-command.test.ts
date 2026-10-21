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

  it('支持 ui.showReasoning / agent.cwd 并保留其它键（0.11.1）', async () => {
    fs.writeFileSync(
      configPath,
      'api_key: sk-test\nui:\n  language: en\nagent:\n  name: demo\n',
      'utf-8',
    );

    const reasoning = await configSetCommand('ui.showReasoning', 'true', {
      userConfigPath: configPath,
    });
    expect(reasoning.exitCode).toBe(0);

    const cwd = await configSetCommand('agent.cwd', '~/project', { userConfigPath: configPath });
    expect(cwd.exitCode).toBe(0);

    const root = parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(root.api_key).toBe('sk-test');
    expect(root.ui).toEqual({ language: 'en', show_reasoning: true });
    expect(root.agent).toEqual({ name: 'demo', cwd: '~/project' });
  });

  it('新键的非法值返回 exit 2 且不写文件', async () => {
    const badBoolean = await configSetCommand('ui.showReasoning', 'yes', {
      userConfigPath: configPath,
    });
    expect(badBoolean.exitCode).toBe(2);
    expect(fs.existsSync(configPath)).toBe(false);

    const badPath = await configSetCommand('agent.cwd', '   ', { userConfigPath: configPath });
    expect(badPath.exitCode).toBe(2);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('解析并写入 ui.statusBars（0.13）', async () => {
    const parsed = parseArgs(['config', 'set', 'ui.statusBars', 'bottom']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.configCommand).toEqual({
        kind: 'set',
        key: 'ui.statusBars',
        value: 'bottom',
        json: false,
      });
    }

    const invalid = parseArgs(['config', 'set', 'ui.statusBars', 'side']);
    expect(invalid.ok).toBe(false);

    fs.writeFileSync(configPath, 'ui:\n  language: en\n', 'utf-8');
    const result = await configSetCommand('ui.statusBars', 'both', {
      userConfigPath: configPath,
    });
    expect(result.exitCode).toBe(0);
    const root = parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(root.ui).toEqual({ language: 'en', status_bars: 'both' });
  });

  it('ui.statusBars 非法值返回 exit 2 且不写文件（0.13）', async () => {
    const result = await configSetCommand('ui.statusBars', 'side', {
      userConfigPath: configPath,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('top');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('解析并写入 ui.askUser（0.15）', async () => {
    const parsed = parseArgs(['config', 'set', 'ui.askUser', 'false']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.configCommand).toEqual({
        kind: 'set',
        key: 'ui.askUser',
        value: 'false',
        json: false,
      });
    }
    expect(parseArgs(['config', 'set', 'ui.askUser', 'yes']).ok).toBe(false);

    fs.writeFileSync(configPath, 'ui:\n  language: en\n', 'utf-8');
    const result = await configSetCommand('ui.askUser', 'false', {
      userConfigPath: configPath,
    });
    expect(result.exitCode).toBe(0);
    const root = parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(root.ui).toEqual({ language: 'en', ask_user: false });
  });

  it('解析新键与非法值（0.11.1）', () => {
    const showReasoning = parseArgs(['config', 'set', 'ui.showReasoning', 'false']);
    expect(showReasoning.ok).toBe(true);
    if (showReasoning.ok) {
      expect(showReasoning.args.configCommand).toEqual({
        kind: 'set',
        key: 'ui.showReasoning',
        value: 'false',
        json: false,
      });
    }

    const cwd = parseArgs(['config', 'set', 'agent.cwd', '~/project']);
    expect(cwd.ok).toBe(true);
    if (cwd.ok) expect(cwd.args.configCommand).toMatchObject({ key: 'agent.cwd' });

    expect(parseArgs(['config', 'set', 'ui.showReasoning', 'yes']).ok).toBe(false);
    expect(parseArgs(['config', 'set', 'agent.cwd', '']).ok).toBe(false);
  });
});
