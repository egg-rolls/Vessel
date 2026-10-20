import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/loader';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-reasoning-cwd-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingUserConfig(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-reasoning-cwd-')), 'missing.yaml');
}

describe('ui.showReasoning（0.11.1）', () => {
  it('ui.show_reasoning 映射为 showReasoning 并接受布尔值', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  show_reasoning: true\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui?.showReasoning).toBe(true);
  });

  it('未配置时不写入默认键（消费方按 === true 处理）', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('provider:\n  name: openai\n  model: gpt-4\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.ui).toBeUndefined();
  });

  it('showReasoning 非布尔时报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('ui:\n  show_reasoning: yes-please\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.map((error) => error.path)).toContain('ui.showReasoning');
  });
});

describe('agent.cwd（0.11.1）', () => {
  it('agent.cwd 原样保留（解析由装配层负责）', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('agent:\n  cwd: ~/work\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.config.agent?.cwd).toBe('~/work');
  });

  it('未配置时不写入默认键', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('provider:\n  name: openai\n  model: gpt-4\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.config.agent).toBeUndefined();
  });

  it('agent.cwd 非字符串或空串时报错', async () => {
    for (const body of ['agent:\n  cwd: 42\n', 'agent:\n  cwd: ""\n']) {
      const result = await loadConfig({
        configPath: tmpYaml(body),
        userConfigPath: missingUserConfig(),
        env: {},
      });
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.map((error) => error.path)).toContain('agent.cwd');
    }
  });

  it('agent 未知键仍报错', async () => {
    const result = await loadConfig({
      configPath: tmpYaml('agent:\n  cwd: /tmp\n  nope: 1\n'),
      userConfigPath: missingUserConfig(),
      env: {},
    });

    expect(result.validation.errors.map((error) => error.path)).toContain('agent.nope');
  });
});
