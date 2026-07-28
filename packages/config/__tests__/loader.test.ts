import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/loader';

// 隔离 VESSEL_* 环境变量，避免本机配置污染测试
const savedVesselEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('VESSEL_')) {
      savedVesselEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedVesselEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedVesselEnv[k];
  }
});

/** 写一个临时 YAML 文件，返回路径 */
function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cfg-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** 一个不存在的项目配置路径（loadConfigFromFile 对不存在的文件返回 {}） */
function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cfg-'));
  return path.join(dir, 'does-not-exist.yaml');
}

describe('loadConfig - model 解析', () => {
  it('custom provider 缺 model 时 fail-fast 报错，而非静默回退 gpt-4', async () => {
    const userConfigPath = tmpYaml(`
api_key: sk-test
default_provider: custom
providers:
  custom:
    api_key: sk-test
    base_url: https://example.com
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
    });

    // 关键断言：不是 gpt-4，而是 undefined + 报错
    expect(config.provider?.model).toBeUndefined();
    expect(config.provider?.model).not.toBe('gpt-4');
    expect(validation.errors.some((e) => e.path === 'provider.model')).toBe(true);
  });

  it('custom provider 配了 model 时正常加载', async () => {
    const userConfigPath = tmpYaml(`
api_key: sk-test
default_provider: custom
default_model: volc-glm-5.2
providers:
  custom:
    api_key: sk-test
    base_url: https://example.com
    model: volc-glm-5.2
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
    });

    expect(config.provider?.model).toBe('volc-glm-5.2');
    expect(config.provider?.name).toBe('custom');
    expect(validation.errors.some((e) => e.path === 'provider.model')).toBe(false);
  });

  it('default_provider: custom 时 provider.name 为 custom，不错显 openai', async () => {
    const userConfigPath = tmpYaml(`
api_key: sk-test
default_provider: custom
default_model: some-model
providers:
  custom:
    api_key: sk-test
    base_url: https://example.com
`);
    const { config } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
    });

    expect(config.provider?.name).toBe('custom');
  });

  it('openai provider 缺 model 时保留安全默认 gpt-4（SPEC §6.2.3）', async () => {
    const userConfigPath = tmpYaml(`
api_key: sk-test
default_provider: openai
providers:
  openai:
    api_key: sk-test
    base_url: https://api.openai.com/v1
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
    });

    expect(config.provider?.model).toBe('gpt-4');
    expect(validation.errors.some((e) => e.path === 'provider.model')).toBe(false);
  });
});
