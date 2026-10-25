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

describe('loadConfig - 0.6.1 permission / plugins / env', () => {
  it('permission.auto_approve 映射为 autoApprove 数组', async () => {
    const userConfigPath = tmpYaml(`
permission:
  auto_approve:
    - bash
    - edit
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(config.permission?.autoApprove).toEqual(['bash', 'edit']);
    expect(validation.errors).toEqual([]);
  });

  it('permission.auto_approve 非字符串数组时报错', async () => {
    const userConfigPath = tmpYaml(`
permission:
  auto_approve: bash
`);
    const { validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(validation.errors.some((e) => e.path === 'permission.autoApprove')).toBe(true);
  });

  it('plugins 条目校验 name/enabled/config 形状', async () => {
    const userConfigPath = tmpYaml(`
plugins:
  - enabled: nope
    config: []
  - name: basic-tools
  - name: basic-tools
`);
    const { validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(validation.errors.some((e) => e.path === 'plugins.0.name')).toBe(true);
    expect(validation.errors.some((e) => e.path === 'plugins.0.enabled')).toBe(true);
    expect(validation.errors.some((e) => e.path === 'plugins.0.config')).toBe(true);
    expect(validation.errors.some((e) => e.path === 'plugins.2.name')).toBe(true);
  });

  it('VESSEL_SESSION_BACKEND 覆盖文件 session.backend', async () => {
    const userConfigPath = tmpYaml(`
session:
  backend: sqlite
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: { VESSEL_SESSION_BACKEND: 'memory' },
    });

    expect(config.session?.backend).toBe('memory');
    expect(validation.errors).toEqual([]);
  });

  it('VESSEL_SESSION_BACKEND 非法值由 validator 报错', async () => {
    const { validation } = await loadConfig({
      userConfigPath: missingPath(),
      configPath: missingPath(),
      env: { VESSEL_SESSION_BACKEND: 'redis' },
    });

    expect(validation.errors.some((e) => e.path === 'session.backend')).toBe(true);
  });

  it('VESSEL_PLUGINS 逗号分隔并整体替换 YAML plugins', async () => {
    const userConfigPath = tmpYaml(`
plugins:
  - name: basic-tools
`);
    const { config } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: { VESSEL_PLUGINS: 'basic-tools, tool-policy ,,' },
    });

    expect(config.plugins).toEqual([
      { name: 'basic-tools', enabled: true },
      { name: 'tool-policy', enabled: true },
    ]);
  });
});

describe('loadConfig - 0.27 permission.never_auto_approve', () => {
  it('maps never_auto_approve to neverAutoApprove', async () => {
    const userConfigPath = tmpYaml(`
permission:
  never_auto_approve:
    - agent.close
    - bash
`);
    const { config, validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(config.permission?.neverAutoApprove).toEqual(['agent.close', 'bash']);
    expect(validation.errors).toEqual([]);
  });

  it('rejects invalid never_auto_approve values', async () => {
    const userConfigPath = tmpYaml(`
permission:
  never_auto_approve: agent.close
`);
    const { validation } = await loadConfig({
      userConfigPath,
      configPath: missingPath(),
      env: {},
    });

    expect(validation.errors.some((e) => e.path === 'permission.neverAutoApprove')).toBe(true);
  });
});
