import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_DATA_DIR, DEFAULT_TRACE_OPTIONS } from '../src/defaults';
import { loadConfig, loadConfigFromFile } from '../src/loader';

/** 写一个临时 YAML 文件，返回路径 */
function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cfg05-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** 一个不存在的配置路径 */
function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cfg05-'));
  return path.join(dir, 'does-not-exist.yaml');
}

const USER_WITH_TENANT = `
default_provider: openai
default_model: user-model
providers:
  openai:
    api_key: sk-user
tenant:
  default: acme
  tenants:
    acme:
      config:
        provider:
          model: overlay-model
`;

function load(options: {
  user?: string;
  project?: string;
  env?: Record<string, string | undefined>;
  defaults?: Record<string, unknown>;
  tenantId?: string;
}) {
  return loadConfig({
    userConfigPath: options.user ?? missingPath(),
    configPath: options.project ?? missingPath(),
    env: options.env ?? {},
    ...(options.defaults ? { defaults: options.defaults } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
  });
}

describe('loadConfig 0.5 - 优先级矩阵（provider.model）', () => {
  const projectWithModel = tmpYaml(`
provider:
  model: project-model
`);

  it('CLI > env > overlay > project > user > default', async () => {
    const user = tmpYaml(USER_WITH_TENANT);
    const project = projectWithModel;

    const cli = await load({
      user,
      project,
      env: { VESSEL_MODEL: 'env-model' },
      defaults: { provider: { model: 'cli-model' } },
    });
    expect(cli.config.provider?.model).toBe('cli-model');
    expect(cli.sources['provider.model']).toBe('cli');

    const env = await load({ user, project, env: { VESSEL_MODEL: 'env-model' } });
    expect(env.config.provider?.model).toBe('env-model');
    expect(env.sources['provider.model']).toBe('env');

    const overlay = await load({ user, project, env: {} });
    expect(overlay.config.provider?.model).toBe('overlay-model');
    expect(overlay.sources['provider.model']).toBeUndefined();
    expect(overlay.tenantOverlayKeys).toContain('provider.model');

    const proj = await load({ user, project, env: {}, tenantId: 'other' });
    expect(proj.config.provider?.model).toBe('project-model');
    expect(proj.sources['provider.model']).toBe('project');

    const usr = await load({ user, env: {}, tenantId: 'other' });
    expect(usr.config.provider?.model).toBe('user-model');
    expect(usr.sources['provider.model']).toBe('user');
  });

  it('都没有时使用 provider-aware 默认值并标记 default', async () => {
    const user = tmpYaml(`
default_provider: openai
providers:
  openai:
    api_key: sk-user
`);

    const { config, sources } = await load({ user, env: {} });

    expect(config.provider?.model).toBe('gpt-4');
    expect(sources['provider.model']).toBe('default');
  });

  it('session.backend 默认 file', () => {
    expect(DEFAULT_CONFIG.session?.backend).toBe('file');
    expect(DEFAULT_DATA_DIR).toBe('~/.vessel/data');
    expect(DEFAULT_TRACE_OPTIONS.level).toBe('full');
  });
});

describe('loadConfig 0.5 - 来源标注', () => {
  it('user / project / env / cli / default 各自标注，_env 解析值记为 env', async () => {
    const user = tmpYaml(`
session:
  backend: sqlite
`);
    const project = tmpYaml(`
feishu:
  session_prefix: project-prefix
  app_secret_env: FEISHU_TEST_SECRET
`);
    const env = {
      VESSEL_API_KEY: 'sk-from-env',
      FEISHU_TEST_SECRET: 'feishu-secret-value',
    };

    const { config, sources } = await load({
      user,
      project,
      env,
      defaults: { dataDir: '/tmp/vessel-data' },
    });

    expect(config.session?.backend).toBe('sqlite');
    expect(sources['session.backend']).toBe('user');

    expect(config.feishu?.sessionPrefix).toBe('project-prefix');
    expect(sources['feishu.sessionPrefix']).toBe('project');

    expect(config.apiKey).toBe('sk-from-env');
    expect(sources.apiKey).toBe('env');

    expect(config.dataDir).toBe('/tmp/vessel-data');
    expect(sources.dataDir).toBe('cli');

    expect(config.limits?.requestLimit).toBe(100);
    expect(sources['limits.requestLimit']).toBe('default');

    expect(config.feishu?.appSecret).toBe('feishu-secret-value');
    expect(sources['feishu.appSecret']).toBe('env');
  });

  it('VESSEL_DATA_DIR 进入 dataDir', async () => {
    const { config, sources } = await load({ env: { VESSEL_DATA_DIR: '/data/vessel' } });
    expect(config.dataDir).toBe('/data/vessel');
    expect(sources.dataDir).toBe('env');
  });
});

describe('loadConfig 0.5 - tenant 解析', () => {
  const user = tmpYaml(`
tenant:
  default: config-tenant
`);

  it('CLI/options > VESSEL_TENANT > config.tenant.default > default', async () => {
    const cli = await load({ user, env: { VESSEL_TENANT: 'env-tenant' }, tenantId: 'cli-tenant' });
    expect(cli.tenantId).toBe('cli-tenant');

    const env = await load({ user, env: { VESSEL_TENANT: 'env-tenant' } });
    expect(env.tenantId).toBe('env-tenant');

    const fromConfig = await load({ user, env: {} });
    expect(fromConfig.tenantId).toBe('config-tenant');

    const fallback = await load({ env: {} });
    expect(fallback.tenantId).toBe('default');
  });

  it('VESSEL_TENANT 不写入 config', async () => {
    const { config } = await load({ env: { VESSEL_TENANT: 'env-tenant' } });
    expect((config as Record<string, unknown>).tenantId).toBeUndefined();
    expect((config as Record<string, unknown>).vesselTenant).toBeUndefined();
  });
});

describe('loadConfig 0.5 - tenant overlay', () => {
  it('overlay 覆盖 project，记录 overlayKeys 且不伪造 source', async () => {
    const user = tmpYaml(`
tenant:
  default: acme
  tenants:
    acme:
      config:
        provider:
          model: overlay-model
`);
    const project = tmpYaml(`
provider:
  model: project-model
`);

    const { config, sources, tenantOverlayKeys } = await load({ user, project, env: {} });

    expect(config.provider?.model).toBe('overlay-model');
    expect(sources['provider.model']).toBeUndefined();
    expect(tenantOverlayKeys).toContain('provider.model');
  });

  it('禁止的块与显式密钥报错，且不泄漏密钥值', async () => {
    const user = tmpYaml(`
tenant:
  default: acme
  tenants:
    acme:
      config:
        serve:
          port: 1234
        provider:
          api_key: tenant-secret-value
`);

    const { validation } = await load({ user, env: {} });
    const paths = validation.errors.map((error) => error.path);

    expect(paths).toContain('tenant.tenants.acme.config.serve');
    expect(paths).toContain('tenant.tenants.acme.config.provider.apiKey');
    expect(validation.errors.some((e) => e.message.includes('tenant-secret-value'))).toBe(false);
    expect(validation.valid).toBe(false);
  });

  it('overlay 只允许 _env 形式，解析后进入配置', async () => {
    const user = tmpYaml(`
tenant:
  default: acme
  tenants:
    acme:
      config:
        provider:
          api_key_env: TENANT_API_KEY
`);
    const env = { TENANT_API_KEY: 'tenant-key-value' };

    const { config, validation, tenantOverlayKeys } = await load({ user, env });

    expect(config.provider?.apiKey).toBe('tenant-key-value');
    expect(tenantOverlayKeys).toContain('provider.apiKey');
    expect(validation.errors.some((e) => e.message.includes('tenant-key-value'))).toBe(false);
  });

  it('non-default tenant overlay _env starts and resolves without being rejected', async () => {
    const user = tmpYaml(`
tenant:
  default: acme
  tenants:
    acme:
      config: {}
    work:
      config:
        provider:
          api_key_env: TENANT_API_KEY
        feishu:
          enabled: true
          app_id: cli_work
          app_secret_env: TENANT_FEISHU_SECRET
`);

    const { config, validation, tenantId } = await load({
      user,
      tenantId: 'work',
      env: {
        TENANT_API_KEY: 'work-key-value',
        TENANT_FEISHU_SECRET: 'work-secret-value',
      },
    });

    expect(tenantId).toBe('work');
    expect(config.provider?.apiKey).toBe('work-key-value');
    expect(config.feishu?.appSecret).toBe('work-secret-value');
    expect(validation.errors).toEqual([]);

    // 原始 overlay 保持 `_env`，不写回解析值。
    const overlay = config.tenant?.tenants?.work?.config;
    expect(overlay?.provider?.apiKey).toBeUndefined();
    expect(overlay?.provider?.apiKeyEnv).toBe('TENANT_API_KEY');
    expect(overlay?.feishu?.appSecret).toBeUndefined();
    expect(overlay?.feishu?.appSecretEnv).toBe('TENANT_FEISHU_SECRET');
  });
});

describe('loadConfig 0.5 - 未知键与项目密钥', () => {
  it('用户/项目未知键按 error 处理（legacy 白名单除外）', async () => {
    const user = tmpYaml(`
default_provider: openai
default_model: gpt-4
providers:
  openai:
    api_key: sk-test
bogus_key: 1
`);
    const project = tmpYaml(`
serve:
  nope: true
`);

    const { validation } = await load({ user, project, env: {} });
    const paths = validation.errors.map((error) => error.path);

    expect(paths).toContain('bogusKey');
    expect(paths).toContain('serve.nope');
    // legacy 键本身不报未知键错误
    expect(paths).not.toContain('defaultProvider');
    expect(paths).not.toContain('defaultModel');
    expect(paths).not.toContain('providers');
  });

  it('项目层显式密钥报错且消息不带值', async () => {
    const project = tmpYaml(`
api_key: sk-project-secret
serve:
  token: project-token-value
transport:
  token: transport-token-value
`);

    const { validation } = await load({ project, env: {} });
    const paths = validation.errors.map((error) => error.path);

    expect(paths).toContain('apiKey');
    expect(paths).toContain('serve.token');
    expect(paths).toContain('transport.token');

    const messages = validation.errors.map((error) => error.message).join(' ');
    expect(messages).not.toContain('sk-project-secret');
    expect(messages).not.toContain('project-token-value');
    expect(messages).not.toContain('transport-token-value');
  });

  it('项目层 _env 形式允许', async () => {
    const project = tmpYaml(`
api_key_env: PROJECT_API_KEY
`);

    const { config, validation } = await load({
      project,
      env: { PROJECT_API_KEY: 'project-key-value' },
    });

    expect(config.apiKey).toBe('project-key-value');
    expect(validation.errors.some((e) => e.path === 'apiKey')).toBe(false);
  });
});

describe('loadConfig 0.5 - empty YAML files', () => {
  it('empty user and project files fall back to defaults', async () => {
    const user = tmpYaml('');
    const project = tmpYaml('   \n\t\n# only a comment\n');

    const { config, validation, tenantId } = await load({ user, project, env: {} });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(config.session?.backend).toBe('file');
    expect(config.context?.maxMessages).toBe(100);
    expect(tenantId).toBe('default');
  });

  it('whitespace-only user config does not throw', async () => {
    const user = tmpYaml('  \n\n\t  \n');
    const { config, validation } = await load({ user, env: {} });

    expect(validation.errors).toEqual([]);
    expect(config).toBeDefined();
  });

  it('loadConfigFromFile returns an empty object for an empty file', async () => {
    const file = tmpYaml('\n\n');
    await expect(loadConfigFromFile(file)).resolves.toEqual({});
  });

  it('non-object YAML roots fall back to empty config', async () => {
    const scalar = tmpYaml('hello\n');
    const list = tmpYaml('- a\n- b\n');

    await expect(loadConfigFromFile(scalar)).resolves.toEqual({});
    await expect(loadConfigFromFile(list)).resolves.toEqual({});
  });
});
