import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigSnapshot, VesselConfig } from '../../packages/config/src/index';
import {
  configInitCommand,
  configPathCommand,
  configShowCommand,
  USER_CONFIG_TEMPLATE,
} from '../config-command';
import { mergeTenantOverlay } from '../tenant-overlay';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cmd-'));
  tempDirs.push(dir);
  return dir;
}

function tmpFile(content: string, name = 'config.yaml'): string {
  const dir = tempDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mergeTenantOverlay (0.5)', () => {
  it('深合并标量/对象、替换数组、按 name 合并 plugins、并集合并 mcpServers', () => {
    const base = {
      provider: { name: 'openai', model: 'base-model', temperature: 0.7 },
      plugins: [
        { name: 'a', enabled: true, config: { x: 1 } },
        { name: 'b', enabled: true },
      ],
      mcpServers: {
        srv: { transport: 'stdio', command: 'run', env: { A: '1' } },
      },
      limits: { requestLimit: 10 },
    } as unknown as VesselConfig;

    const overlay = {
      provider: { model: 'tenant-model' },
      plugins: [{ name: 'a', enabled: false }, { name: 'c' }],
      mcpServers: {
        srv: { env: { B: '2' } },
        srv2: { transport: 'http', url: 'https://example.com' },
      },
    } as unknown as VesselConfig;

    const { config, overlayKeys, errors } = mergeTenantOverlay(base, overlay, {
      tenantId: 'acme',
    });

    expect(errors).toEqual([]);
    expect(config.provider?.model).toBe('tenant-model');
    expect(config.provider?.temperature).toBe(0.7);
    expect(config.plugins).toEqual([
      { name: 'a', enabled: false, config: { x: 1 } },
      { name: 'b', enabled: true },
      { name: 'c' },
    ]);
    expect(config.mcpServers?.srv).toEqual({
      transport: 'stdio',
      command: 'run',
      env: { A: '1', B: '2' },
    });
    expect(config.mcpServers?.srv2).toEqual({
      transport: 'http',
      url: 'https://example.com',
    });
    expect(overlayKeys).toEqual(
      expect.arrayContaining([
        'provider.model',
        'plugins',
        'mcpServers.srv.env.B',
        'mcpServers.srv2.transport',
      ]),
    );
    // 不修改入参
    expect(base.provider?.model).toBe('base-model');
  });

  it('null / 禁止块 / 未知块 / 显式密钥报错且不静默', () => {
    const base = { context: { maxTokens: 1 } } as VesselConfig;
    const overlay = {
      context: null,
      serve: { port: 1234 },
      tenant: { default: 'x' },
      bogus: true,
      provider: { name: 'openai', apiKey: 'tenant-secret' },
    } as unknown as VesselConfig;

    const { errors, config } = mergeTenantOverlay(base, overlay, { tenantId: 'acme' });
    const paths = errors.map((error) => error.path);

    expect(paths).toContain('tenant.tenants.acme.config.context');
    expect(paths).toContain('tenant.tenants.acme.config.serve');
    expect(paths).toContain('tenant.tenants.acme.config.tenant');
    expect(paths).toContain('tenant.tenants.acme.config.bogus');
    expect(paths).toContain('tenant.tenants.acme.config.provider.apiKey');
    expect(errors.some((error) => error.message.includes('tenant-secret'))).toBe(false);
    expect(config.context?.maxTokens).toBe(1);
    expect((config as Record<string, unknown>).serve).toBeUndefined();
  });

  it('tools/quota 是 tenant 设置层字段，不进入 VesselConfig 也不报错', () => {
    const overlay = {
      tools: { allow: ['bash'] },
      quota: { maxSessions: 2 },
    } as unknown as VesselConfig;

    const { config, errors } = mergeTenantOverlay({}, overlay, { tenantId: 'acme' });

    expect(errors).toEqual([]);
    expect((config as Record<string, unknown>).tools).toBeUndefined();
    expect((config as Record<string, unknown>).quota).toBeUndefined();
  });
});

describe('config command (0.5)', () => {
  it('config path 输出用户/项目/data 路径与存在性', async () => {
    const userConfigPath = tmpFile('api_key: sk-test\n');
    const configPath = path.join(tempDir(), 'vessel.yaml');

    const text = await configPathCommand({
      userConfigPath,
      configPath,
      env: { VESSEL_DATA_DIR: '/data/vessel' },
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('user:');
    expect(text.stdout).toContain('(exists)');
    expect(text.stdout).toContain('project:');
    expect(text.stdout).toContain('(missing)');
    expect(text.stdout).toContain('data:');

    const json = await configPathCommand({
      json: true,
      userConfigPath,
      configPath,
      env: { VESSEL_DATA_DIR: '/data/vessel' },
    });
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      user: string;
      project: string;
      data_dir: string;
      exists: { user: boolean; project: boolean };
    };
    expect(parsed.user).toBe(path.resolve(userConfigPath));
    expect(parsed.project).toBe(path.resolve(configPath));
    expect(parsed.data_dir).toBe(path.resolve('/data/vessel'));
    expect(parsed.exists).toEqual({ user: true, project: false });
  });

  it('config init 写模板、拒绝覆盖、--force 覆盖', async () => {
    const target = path.join(tempDir(), 'nested', 'config.yaml');

    const first = await configInitCommand({ userConfigPath: target });
    expect(first.exitCode).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(USER_CONFIG_TEMPLATE);
    expect(fs.readFileSync(target, 'utf8')).toContain('api_key_env: VESSEL_API_KEY');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('sk-');

    const second = await configInitCommand({ userConfigPath: target });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('--force');

    const forced = await configInitCommand({ userConfigPath: target, force: true, json: true });
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(forced.stdout)).toEqual({ path: target, created: true });
  });

  it('config show --json 输出脱敏 ConfigSnapshot 与来源', async () => {
    const userConfigPath = tmpFile(`
api_key: sk-user-secret
provider:
  name: openai
  model: gpt-4
`);

    const result = await configShowCommand({
      json: true,
      sources: true,
      userConfigPath,
      configPath: path.join(tempDir(), 'missing.yaml'),
      env: {},
    });

    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(result.stdout) as ConfigSnapshot;

    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.config.apiKey).toBe('<set>');
    expect(result.stdout).not.toContain('sk-user-secret');
    expect(snapshot.sources.apiKey).toBe('user');
    expect(snapshot.sources['provider.model']).toBe('user');
    expect(snapshot.paths.user).toBe(userConfigPath);
    expect(snapshot.tenant_id).toBe('default');
  });

  it('config show 校验错误 exit 1 且打印路径', async () => {
    const userConfigPath = tmpFile(`
api_key: sk-test
bogus_key: 1
`);

    const result = await configShowCommand({
      json: true,
      userConfigPath,
      configPath: path.join(tempDir(), 'missing.yaml'),
      env: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bogusKey');
  });

  it('config show 记录 tenant overlay keys 且不伪造 source', async () => {
    const userConfigPath = tmpFile(`
api_key: sk-test
tenant:
  default: acme
  tenants:
    acme:
      config:
        provider:
          model: overlay-model
`);

    const result = await configShowCommand({
      json: true,
      userConfigPath,
      configPath: path.join(tempDir(), 'missing.yaml'),
      env: {},
    });

    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(result.stdout) as ConfigSnapshot;
    expect(snapshot.config.provider?.model).toBe('overlay-model');
    expect(snapshot.tenant_overlay_keys).toContain('provider.model');
    expect(snapshot.sources['provider.model']).toBeUndefined();
  });
});
