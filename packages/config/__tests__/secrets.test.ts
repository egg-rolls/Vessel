import { describe, expect, it } from 'bun:test';
import { redactConfig, resolveEnvRefsInLayer, resolveSecret, secretMarker } from '../src/secrets';
import type { VesselConfig } from '../src/types';

const ENV: Record<string, string | undefined> = {
  OPENAI_KEY: 'sk-live',
  PROVIDER_KEY: 'sk-provider',
  FEISHU_SECRET: 'feishu-secret',
  SERVE_TOKEN: 'serve-token',
  ADMIN_TOKEN: 'admin-token',
  MCP_KEY: 'mcp-secret',
  AUTH_HEADER: 'Bearer header-secret',
  EMPTY_VAR: '',
  'BAD NAME': 'never-used',
};

/**
 * Commit 1 尚未扩展 VesselConfig 类型（Commit 2 才加 _env / serve.tokens 等），
 * 测试用前向声明读取解析结果。
 */
interface LooseLayer {
  apiKey?: string;
  apiKeyEnv?: string;
  provider?: {
    name?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    maxTokens?: number;
    timeoutMs?: number;
  };
  feishu?: { enabled?: boolean; appId?: string; appSecret?: string; appSecretEnv?: string };
  serve?: {
    token?: string;
    tokenEnv?: string;
    adminToken?: string;
    adminTokenEnv?: string;
    tokens?: Record<string, unknown>;
  };
  transport?: { token?: string };
  tenant?: { default?: string; tenants?: Record<string, { config?: LooseLayer }> };
  mcpServers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
  custom?: Record<string, unknown>;
  tokenEnv?: string;
}

function asLayer(value: unknown): LooseLayer {
  return value as LooseLayer;
}

describe('resolveSecret', () => {
  it('同层显式非空值优先', () => {
    expect(resolveSecret({ value: 'explicit', envRef: 'OPENAI_KEY', env: ENV })).toEqual({
      state: 'set',
      value: 'explicit',
    });
  });

  it('显式值优先时忽略非法 env 名（不报错）', () => {
    expect(resolveSecret({ value: 'explicit', envRef: 'BAD NAME', env: ENV })).toEqual({
      state: 'set',
      value: 'explicit',
    });
  });

  it('显式空串时回退到 _env', () => {
    expect(resolveSecret({ value: '', envRef: 'OPENAI_KEY', env: ENV })).toEqual({
      state: 'set',
      value: 'sk-live',
      envRef: 'OPENAI_KEY',
    });
  });

  it('_env 命中', () => {
    expect(resolveSecret({ envRef: 'OPENAI_KEY', env: ENV })).toEqual({
      state: 'set',
      value: 'sk-live',
      envRef: 'OPENAI_KEY',
    });
  });

  it('_env 指向的变量未定义 → config_env_missing', () => {
    const state = resolveSecret({ envRef: 'MISSING_KEY', env: ENV });
    expect(state.state).toBe('error');
    if (state.state === 'error') {
      expect(state.code).toBe('config_env_missing');
      expect(state.envRef).toBe('MISSING_KEY');
      expect(state.message).toContain('MISSING_KEY');
    }
  });

  it('_env 指向的变量为空串 → config_env_empty', () => {
    const state = resolveSecret({ envRef: 'EMPTY_VAR', env: ENV });
    expect(state.state).toBe('error');
    if (state.state === 'error') {
      expect(state.code).toBe('config_env_empty');
      expect(state.envRef).toBe('EMPTY_VAR');
    }
  });

  it('非法 env 名 → config_env_invalid', () => {
    const state = resolveSecret({ envRef: 'BAD NAME', env: ENV });
    expect(state.state).toBe('error');
    if (state.state === 'error') {
      expect(state.code).toBe('config_env_invalid');
      expect(state.envRef).toBe('BAD NAME');
    }
  });

  it('两者都没有 → unset', () => {
    expect(resolveSecret({ env: ENV })).toEqual({ state: 'unset' });
    expect(resolveSecret({ value: '', env: ENV })).toEqual({ state: 'unset' });
  });
});

describe('resolveEnvRefsInLayer', () => {
  it('解析顶层、provider、feishu、serve 的 _env', () => {
    const input = {
      apiKeyEnv: 'OPENAI_KEY',
      provider: { name: 'openai', apiKeyEnv: 'PROVIDER_KEY' },
      feishu: { enabled: true, appSecretEnv: 'FEISHU_SECRET' },
      serve: { tokenEnv: 'SERVE_TOKEN', adminTokenEnv: 'ADMIN_TOKEN' },
    } as unknown as Partial<VesselConfig>;

    const { layer, errors, resolved } = resolveEnvRefsInLayer(input, ENV);
    const out = asLayer(layer);

    expect(errors).toEqual([]);
    expect(out.apiKey).toBe('sk-live');
    expect(out.provider?.apiKey).toBe('sk-provider');
    expect(out.feishu?.appSecret).toBe('feishu-secret');
    expect(out.serve?.token).toBe('serve-token');
    expect(out.serve?.adminToken).toBe('admin-token');
    expect(resolved).toEqual({
      apiKey: 'OPENAI_KEY',
      'provider.apiKey': 'PROVIDER_KEY',
      'feishu.appSecret': 'FEISHU_SECRET',
      'serve.token': 'SERVE_TOKEN',
      'serve.adminToken': 'ADMIN_TOKEN',
    });
  });

  it('同层显式值优先，_env 被忽略', () => {
    const input = {
      apiKey: 'explicit',
      apiKeyEnv: 'OPENAI_KEY',
      provider: { name: 'openai', apiKey: 'explicit-provider', apiKeyEnv: 'PROVIDER_KEY' },
    } as unknown as Partial<VesselConfig>;

    const { layer } = resolveEnvRefsInLayer(input, ENV);
    const out = asLayer(layer);

    expect(out.apiKey).toBe('explicit');
    expect(out.provider?.apiKey).toBe('explicit-provider');
  });

  it('缺失变量报错且路径指向 _env 字段', () => {
    const input = {
      provider: { name: 'openai', apiKeyEnv: 'MISSING_KEY' },
    } as unknown as Partial<VesselConfig>;

    const { errors } = resolveEnvRefsInLayer(input, ENV);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('provider.apiKeyEnv');
    expect(errors[0]?.message).toContain('MISSING_KEY');
  });

  it('不修改入参', () => {
    const input = { apiKeyEnv: 'OPENAI_KEY' } as unknown as Partial<VesselConfig>;
    const { layer } = resolveEnvRefsInLayer(input, ENV);

    expect(asLayer(input).apiKey).toBeUndefined();
    expect(asLayer(layer).apiKey).toBe('sk-live');
  });

  it('解析 mcpServers.env / headers 的 _env 并移除 _env 键', () => {
    const input = {
      mcpServers: {
        srv: {
          transport: 'http',
          url: 'https://example.com',
          env: { API_KEY_env: 'MCP_KEY' },
          headers: { Authorization_env: 'AUTH_HEADER' },
        },
      },
    } as unknown as Partial<VesselConfig>;

    const { layer, errors, resolved } = resolveEnvRefsInLayer(input, ENV);
    const out = asLayer(layer);

    expect(errors).toEqual([]);
    expect(out.mcpServers?.srv?.env).toEqual({ API_KEY: 'mcp-secret' });
    expect(out.mcpServers?.srv?.headers).toEqual({ Authorization: 'Bearer header-secret' });
    expect(resolved).toEqual({
      'mcpServers.srv.env.API_KEY': 'MCP_KEY',
      'mcpServers.srv.headers.Authorization': 'AUTH_HEADER',
    });
  });

  it('MCP 同层显式目标键优先', () => {
    const input = {
      mcpServers: {
        srv: {
          transport: 'stdio',
          command: 'run',
          env: { API_KEY: 'explicit', API_KEY_env: 'MCP_KEY' },
        },
      },
    } as unknown as Partial<VesselConfig>;

    const { layer } = resolveEnvRefsInLayer(input, ENV);

    expect(asLayer(layer).mcpServers?.srv?.env).toEqual({ API_KEY: 'explicit' });
  });

  it('MCP 缺失变量报错，路径指向 <KEY>_env', () => {
    const input = {
      mcpServers: {
        srv: { transport: 'stdio', command: 'run', env: { API_KEY_env: 'MISSING_KEY' } },
      },
    } as unknown as Partial<VesselConfig>;

    const { errors } = resolveEnvRefsInLayer(input, ENV);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('mcpServers.srv.env.API_KEY_env');
    expect(errors[0]?.message).toContain('MISSING_KEY');
  });

  it('解析 tenant overlay 内的 mcpServers _env（overlay 单独解析）', () => {
    // loader 在选中 tenant 时把 settings.config 单独传入；层解析不触碰
    // `tenant.tenants.*.config`，以保留 `_env` 供 validator 判定。
    const input = {
      mcpServers: {
        srv: { transport: 'stdio', command: 'run', env: { API_KEY_env: 'MCP_KEY' } },
      },
    } as unknown as Partial<VesselConfig>;

    const { layer, errors, resolved } = resolveEnvRefsInLayer(input, ENV);
    const out = asLayer(layer);

    expect(errors).toEqual([]);
    expect(out.mcpServers?.srv?.env).toEqual({ API_KEY: 'mcp-secret' });
    expect(resolved).toEqual({ 'mcpServers.srv.env.API_KEY': 'MCP_KEY' });
  });

  it('层解析保留 tenant.tenants 内的 _env（不提前写回密钥）', () => {
    const input = {
      tenant: {
        default: 'acme',
        tenants: {
          acme: {
            config: {
              provider: { apiKeyEnv: 'TENANT_KEY' },
            },
          },
        },
      },
    } as unknown as Partial<VesselConfig>;

    const { layer, errors } = resolveEnvRefsInLayer(input, ENV);
    const out = asLayer(layer);

    expect(errors).toEqual([]);
    expect(out.tenant?.tenants?.acme?.config?.provider?.apiKey).toBeUndefined();
    expect(out.tenant?.tenants?.acme?.config?.provider?.apiKeyEnv).toBe('TENANT_KEY');
  });
});

describe('secretMarker / redactConfig', () => {
  it('secretMarker 只区分 set/unset', () => {
    expect(secretMarker('value')).toBe('<set>');
    expect(secretMarker('')).toBe('<unset>');
    expect(secretMarker(undefined)).toBe('<unset>');
  });

  it('固定密钥字段脱敏且不泄漏原始值', () => {
    const config = {
      apiKey: 'sk-top-secret',
      provider: { name: 'openai', apiKey: 'sk-provider-secret' },
      feishu: { enabled: true, appId: 'cli_123456', appSecret: 'feishu-secret' },
      serve: {
        token: 'serve-secret',
        adminToken: 'admin-secret',
        tokens: { 'raw-token-key': { tenantId: 'acme', role: 'admin' } },
      },
      transport: { token: 'transport-secret' },
      mcpServers: {
        srv: {
          transport: 'stdio',
          command: 'run',
          env: { API_KEY: 'mcp-env-secret' },
          headers: { Authorization: 'Bearer mcp-header-secret' },
        },
      },
    } as unknown as VesselConfig;

    const redacted = asLayer(redactConfig(config));
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('sk-top-secret');
    expect(serialized).not.toContain('sk-provider-secret');
    expect(serialized).not.toContain('feishu-secret');
    expect(serialized).not.toContain('serve-secret');
    expect(serialized).not.toContain('admin-secret');
    expect(serialized).not.toContain('transport-secret');
    expect(serialized).not.toContain('mcp-env-secret');
    expect(serialized).not.toContain('mcp-header-secret');
    expect(serialized).not.toContain('raw-token-key');

    expect(redacted.apiKey).toBe('<set>');
    expect(redacted.provider?.apiKey).toBe('<set>');
    expect(redacted.feishu?.appSecret).toBe('<set>');
    expect(redacted.feishu?.appId).toBe('cli_***');
    expect(redacted.serve?.token).toBe('<set>');
    expect(redacted.serve?.adminToken).toBe('<set>');
    expect(redacted.serve?.tokens).toEqual({ '<set>': { tenantId: 'acme', role: 'admin' } });
    expect(redacted.transport?.token).toBe('<set>');
    expect(redacted.mcpServers?.srv?.env).toEqual({ API_KEY: '<set>' });
    expect(redacted.mcpServers?.srv?.headers).toEqual({ Authorization: '<set>' });
  });

  it('未设置的字段保持缺省', () => {
    const redacted = asLayer(redactConfig({ provider: { name: 'openai' } } as VesselConfig));
    expect(redacted.apiKey).toBeUndefined();
    expect(redacted.provider?.apiKey).toBeUndefined();
  });

  it('递归键名兜底：password/secret 脱敏，env 名与 maxTokens 不受影响', () => {
    const config = {
      provider: { name: 'openai', maxTokens: 4096, timeoutMs: 1000 },
      custom: { password: 'hunter2', client_secret: 'client-secret', tokenEnv: 'SAFE_REF' },
      tokenEnv: 'SAFE_REF',
    } as unknown as VesselConfig;

    const redacted = asLayer(redactConfig(config));

    expect(redacted.custom?.password).toBe('<set>');
    expect(redacted.custom?.client_secret).toBe('<set>');
    expect(redacted.custom?.tokenEnv).toBe('SAFE_REF');
    expect(redacted.tokenEnv).toBe('SAFE_REF');
    expect(redacted.provider).toEqual({ name: 'openai', maxTokens: 4096, timeoutMs: 1000 });
  });
});
