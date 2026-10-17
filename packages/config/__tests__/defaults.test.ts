import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../src/defaults';
import { loadConfig } from '../src/loader';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('VESSEL_')) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

/** 写一个临时 YAML 配置文件 */
function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-defaults-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** 指向不存在的配置文件 */
function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

describe('DEFAULT_CONFIG', () => {
  it('不再全局写死 model；session.backend 默认 sqlite', () => {
    expect(DEFAULT_CONFIG.provider?.model).toBeUndefined();
    expect(DEFAULT_CONFIG.session?.backend).toBe('sqlite');
    expect(DEFAULT_CONFIG.session?.maxHistory).toBeUndefined();
  });

  it('嵌套默认值不跨 loadConfig 调用共享（structuredClone）', async () => {
    const first = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    if (first.config.provider) first.config.provider.name = 'mutated';
    if (first.config.limits) first.config.limits.requestLimit = 1;

    const second = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });

    expect(second.config.provider?.name).toBe('openai');
    expect(second.config.limits?.requestLimit).toBe(100);
    expect(DEFAULT_CONFIG.provider?.name).toBe('openai');
    expect(DEFAULT_CONFIG.limits?.requestLimit).toBe(100);
  });
});

describe('provider-aware 默认 model', () => {
  it('openai 缺 model 时补 gpt-4', async () => {
    const { config } = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    expect(config.provider?.name).toBe('openai');
    expect(config.provider?.model).toBe('gpt-4');
  });

  it('未知 provider 缺 model 时不回退 gpt-4，validator 报错', async () => {
    const userConfigPath = tmpYaml(`
api_key: sk-test
default_provider: custom
providers:
  custom:
    api_key: sk-test
    base_url: https://example.com
`);
    const { config, validation } = await loadConfig({
      configPath: missingPath(),
      userConfigPath,
    });
    expect(config.provider?.model).toBeUndefined();
    expect(validation.errors.some((e) => e.path === 'provider.model')).toBe(true);
  });
});

describe('环境变量', () => {
  it('VESSEL_PROVIDER_API_KEY 回填顶层 apiKey（不再是死变量）', async () => {
    process.env.VESSEL_PROVIDER_API_KEY = 'sk-from-provider-env';
    const { config } = await loadConfig({
      configPath: missingPath(),
      userConfigPath: missingPath(),
    });
    expect(config.apiKey).toBe('sk-from-provider-env');
    expect(config.provider?.apiKey).toBe('sk-from-provider-env');
  });

  it('VESSEL_MODEL 覆盖文件配置', async () => {
    process.env.VESSEL_MODEL = 'env-model';
    const configPath = tmpYaml('provider:\n  model: file-model\n');
    const { config } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    expect(config.provider?.model).toBe('env-model');
  });
});

describe('未知键与新增 schema', () => {
  it('顶层未知键报 error，并给出拼写建议', async () => {
    const configPath = tmpYaml('provder:\n  name: openai\n');
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    const unknown = validation.errors.find((e) => e.path === 'provder');
    expect(unknown).toBeDefined();
    expect(unknown?.message).toContain('Did you mean "provider"');
    expect(validation.valid).toBe(false);
  });

  it('update.channel 非枚举时报错', async () => {
    const configPath = tmpYaml('update:\n  channel: nightly\n');
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    expect(validation.errors.some((e) => e.path === 'update.channel')).toBe(true);
  });

  it('delegate.max_depth 非正整数时报错', async () => {
    const configPath = tmpYaml('delegate:\n  max_depth: 0\n');
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    expect(validation.errors.some((e) => e.path === 'delegate.maxDepth')).toBe(true);
  });

  it('session.backend 非枚举时报错', async () => {
    const configPath = tmpYaml('session:\n  backend: redis\n');
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    expect(validation.errors.some((e) => e.path === 'session.backend')).toBe(true);
  });

  it('provider.timeout_ms 允许 <=0（关闭），拒绝非数字', async () => {
    const ok = await loadConfig({
      configPath: tmpYaml('provider:\n  timeout_ms: 0\n'),
      userConfigPath: missingPath(),
    });
    expect(ok.validation.errors.some((e) => e.path === 'provider.timeoutMs')).toBe(false);
    expect(ok.config.provider?.timeoutMs).toBe(0);

    const bad = await loadConfig({
      configPath: tmpYaml('provider:\n  timeout_ms: fast\n'),
      userConfigPath: missingPath(),
    });
    expect(bad.validation.errors.some((e) => e.path === 'provider.timeoutMs')).toBe(true);
  });

  it('delegate.permission_mode / read_only_tools 校验', async () => {
    const ok = await loadConfig({
      configPath: tmpYaml('delegate:\n  permission_mode: deny\n  read_only_tools: [read, bash]\n'),
      userConfigPath: missingPath(),
    });
    expect(ok.validation.errors).toHaveLength(0);
    expect(ok.config.delegate?.permissionMode).toBe('deny');
    expect(ok.config.delegate?.readOnlyTools).toEqual(['read', 'bash']);

    const bad = await loadConfig({
      configPath: tmpYaml('delegate:\n  permission_mode: ask\n'),
      userConfigPath: missingPath(),
    });
    expect(bad.validation.errors.some((e) => e.path === 'delegate.permissionMode')).toBe(true);
  });

  it('team 块校验（enabled 显式 opt-in）', async () => {
    const ok = await loadConfig({
      configPath: tmpYaml('team:\n  enabled: true\n  max_members: 4\n  owner_id: lead\n'),
      userConfigPath: missingPath(),
    });
    expect(ok.validation.errors).toHaveLength(0);
    expect(ok.config.team?.enabled).toBe(true);

    const bad = await loadConfig({
      configPath: tmpYaml('team:\n  max_members: 0\n'),
      userConfigPath: missingPath(),
    });
    expect(bad.validation.errors.some((e) => e.path === 'team.maxMembers')).toBe(true);
  });
});

describe('未消费字段显式 warning', () => {
  it('agent.temperature / session.max_history / guardrails 不再静默忽略', async () => {
    const configPath = tmpYaml(`
agent:
  temperature: 0.2
session:
  max_history: 50
guardrails:
  - name: pii
`);
    const { validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
    });
    const paths = validation.warnings.map((w) => w.path);
    expect(paths).toContain('agent.temperature');
    expect(paths).toContain('session.maxHistory');
    expect(paths).toContain('guardrails');
  });
});
