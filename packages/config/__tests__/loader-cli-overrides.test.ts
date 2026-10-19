import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/loader';

/** 写临时 YAML，返回路径 */
function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cli-layer-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** 不存在的配置路径（隔离宿主 ~/.vessel/config.yaml 与 ./vessel.yaml） */
function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cli-layer-'));
  return path.join(dir, 'missing.yaml');
}

interface LoadInput {
  user?: string;
  project?: string;
  env?: Record<string, string | undefined>;
  cliOverrides?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  tenantId?: string;
}

function load(input: LoadInput) {
  return loadConfig({
    userConfigPath: input.user ?? missingPath(),
    configPath: input.project ?? missingPath(),
    env: input.env ?? {},
    ...(input.cliOverrides ? { cliOverrides: input.cliOverrides } : {}),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
}

const USER_WITH_OVERLAY = `
provider:
  name: openai
  model: user-model
tenant:
  default: acme
  tenants:
    acme:
      config:
        provider:
          model: overlay-model
`;

const PROJECT_MODEL = tmpYaml(`
provider:
  model: project-model
`);

describe('cliOverrides - 层序矩阵', () => {
  it('CLI > env > tenant overlay > project > user', async () => {
    const user = tmpYaml(USER_WITH_OVERLAY);

    const cli = await load({
      user,
      project: PROJECT_MODEL,
      env: { VESSEL_MODEL: 'env-model' },
      cliOverrides: { provider: { model: 'cli-model' } },
    });
    expect(cli.config.provider?.model).toBe('cli-model');
    expect(cli.sources['provider.model']).toBe('cli');

    const env = await load({
      user,
      project: PROJECT_MODEL,
      env: { VESSEL_MODEL: 'env-model' },
    });
    expect(env.config.provider?.model).toBe('env-model');
    expect(env.sources['provider.model']).toBe('env');

    const overlay = await load({ user, project: PROJECT_MODEL, env: {} });
    expect(overlay.config.provider?.model).toBe('overlay-model');
    expect(overlay.tenantOverlayKeys).toContain('provider.model');
  });

  it('三层组合：CLI > project > user', async () => {
    const user = tmpYaml(`provider:\n  model: user-model\n`);

    const cli = await load({
      user,
      project: PROJECT_MODEL,
      cliOverrides: { provider: { model: 'cli-model' } },
    });
    expect(cli.config.provider?.model).toBe('cli-model');
    expect(cli.sources['provider.model']).toBe('cli');

    const project = await load({ user, project: PROJECT_MODEL });
    expect(project.config.provider?.model).toBe('project-model');
    expect(project.sources['provider.model']).toBe('project');
  });

  it('三层组合：CLI > env > user（无 project）', async () => {
    const user = tmpYaml(`provider:\n  model: user-model\n`);

    const result = await load({
      user,
      env: { VESSEL_MODEL: 'env-model' },
      cliOverrides: { provider: { model: 'cli-model' } },
    });
    expect(result.config.provider?.model).toBe('cli-model');
    expect(result.sources['provider.model']).toBe('cli');
  });

  it('三层组合：env > project > user（未提供 CLI 层时行为不变）', async () => {
    const user = tmpYaml(`provider:\n  model: user-model\n`);

    const env = await load({ user, project: PROJECT_MODEL, env: { VESSEL_MODEL: 'env-model' } });
    expect(env.config.provider?.model).toBe('env-model');
    expect(env.sources['provider.model']).toBe('env');

    const project = await load({ user, project: PROJECT_MODEL, env: {} });
    expect(project.config.provider?.model).toBe('project-model');

    const legacy = await load({ user, env: {} });
    expect(legacy.config.provider?.model).toBe('user-model');
  });

  it('`defaults` 仍是 CLI 层；与 cliOverrides 同给时后者优先', async () => {
    const withDefaults = await load({
      defaults: { provider: { model: 'legacy-cli' } },
    });
    expect(withDefaults.config.provider?.model).toBe('legacy-cli');
    expect(withDefaults.sources['provider.model']).toBe('cli');

    const both = await load({
      defaults: { provider: { model: 'legacy-cli' } },
      cliOverrides: { provider: { model: 'new-cli' } },
    });
    expect(both.config.provider?.model).toBe('new-cli');
    expect(both.sources['provider.model']).toBe('cli');
  });

  it('CLI 数组整体替换（serve.allowedOrigins）', async () => {
    const user = tmpYaml(`
serve:
  allowed_origins:
    - https://user.example.com
`);

    const { config, sources } = await load({
      user,
      cliOverrides: { serve: { allowedOrigins: ['https://cli.example.com'] } },
    });
    expect(config.serve?.allowedOrigins).toEqual(['https://cli.example.com']);
    expect(sources['serve.allowedOrigins']).toBe('cli');
  });
});

describe('connect token / CA - env 层接入', () => {
  const USER_CONNECT = tmpYaml(`
connect:
  token: user-token
  ca_file: user-ca.pem
`);

  it('env 覆盖 user 配置；来源为 env', async () => {
    const result = await load({
      user: USER_CONNECT,
      env: {
        VESSEL_CONNECT_TOKEN: 'env-token',
        VESSEL_CONNECT_CA: 'env-ca.pem',
      },
    });
    expect(result.config.connect?.token).toBe('env-token');
    expect(result.config.connect?.caFile).toBe('env-ca.pem');
    expect(result.sources['connect.token']).toBe('env');
    expect(result.sources['connect.caFile']).toBe('env');
  });

  it('VESSEL_CONNECT_TOKEN 优先于 VESSEL_GATEWAY_TOKEN', async () => {
    const result = await load({
      user: USER_CONNECT,
      env: {
        VESSEL_CONNECT_TOKEN: 'connect-token',
        VESSEL_GATEWAY_TOKEN: 'gateway-token',
      },
    });
    expect(result.config.connect?.token).toBe('connect-token');
  });

  it('VESSEL_GATEWAY_TOKEN 是 env 层的 token 回退（高于 user 配置）', async () => {
    const result = await load({
      user: USER_CONNECT,
      env: { VESSEL_GATEWAY_TOKEN: 'gateway-token' },
    });
    expect(result.config.connect?.token).toBe('gateway-token');
    expect(result.sources['connect.token']).toBe('env');
  });

  it('CLI connect.token / caFile 高于 env', async () => {
    const result = await load({
      user: USER_CONNECT,
      env: {
        VESSEL_CONNECT_TOKEN: 'env-token',
        VESSEL_CONNECT_CA: 'env-ca.pem',
      },
      cliOverrides: { connect: { token: 'cli-token', caFile: 'cli-ca.pem' } },
    });
    expect(result.config.connect?.token).toBe('cli-token');
    expect(result.config.connect?.caFile).toBe('cli-ca.pem');
    expect(result.sources['connect.token']).toBe('cli');
    expect(result.sources['connect.caFile']).toBe('cli');
  });

  it('无 env / CLI 时保留 user 配置（旧行为不变）', async () => {
    const result = await load({ user: USER_CONNECT, env: {} });
    expect(result.config.connect?.token).toBe('user-token');
    expect(result.config.connect?.caFile).toBe('user-ca.pem');
    expect(result.sources['connect.token']).toBe('user');
  });
});
