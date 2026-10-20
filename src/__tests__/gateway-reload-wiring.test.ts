import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  allowedOriginsChanged,
  createGatewayReload,
  diffRestartFields,
  type GatewayReconfigureTarget,
  type GatewayReloadWiringOptions,
} from '../gateway-reload-wiring';

function config(overrides: Partial<VesselConfig> = {}): VesselConfig {
  return {
    provider: { name: 'openai', model: 'gpt-4o', apiKey: 'k' },
    serve: { allowedOrigins: ['http://a.example'] },
    ...overrides,
  } as VesselConfig;
}

function deps(
  overrides: Partial<GatewayReloadWiringOptions> & {
    current?: VesselConfig;
    next?: VesselConfig;
  } = {},
): GatewayReloadWiringOptions & { refreshCount: () => number; loadCount: () => number } {
  const current = overrides.current ?? config();
  const next = overrides.next ?? current;
  let refreshCount = 0;
  let loadCount = 0;
  return {
    gateway: () => ({}) as GatewayReconfigureTarget,
    currentConfig: () => current,
    reloadConfig: async () => {
      loadCount += 1;
      return next;
    },
    refreshPlugins: () => {
      refreshCount += 1;
    },
    ...overrides,
    refreshCount: () => refreshCount,
    loadCount: () => loadCount,
  };
}

describe('diffRestartFields', () => {
  it('无变化返回空；各域独立命名', () => {
    expect(diffRestartFields(config(), config())).toEqual([]);
    expect(
      diffRestartFields(
        config(),
        config({ provider: { name: 'anthropic', model: 'gpt-4o', apiKey: 'k' } }),
      ),
    ).toEqual(['provider']);
    expect(
      diffRestartFields(
        config(),
        config({ provider: { name: 'openai', model: 'other', apiKey: 'k' } }),
      ),
    ).toEqual(['model']);
    expect(diffRestartFields(config(), config({ agent: { cwd: '/tmp' } }))).toEqual(['agent']);
    expect(diffRestartFields(config(), config({ permission: {} }))).toEqual(['permission']);
    expect(
      diffRestartFields(
        config(),
        config({
          serve: {
            allowedOrigins: ['http://a.example'],
            tls: { certFile: 'c', keyFile: 'k' },
          },
        }),
      ),
    ).toEqual(['tls']);
    expect(
      diffRestartFields(
        config(),
        config({
          serve: { allowedOrigins: ['http://a.example'], token: 'next' },
        }),
      ),
    ).toEqual(['token']);
    expect(
      diffRestartFields(
        config(),
        config({ serve: { allowedOrigins: ['http://a.example'], port: 9000 } }),
      ),
    ).toEqual(['port']);
  });

  it('allowed_origins 不是需重启字段（顺序无关）', () => {
    const next = config({ serve: { allowedOrigins: ['http://b.example'] } });
    expect(diffRestartFields(config(), next)).toEqual([]);
    expect(allowedOriginsChanged(config(), next)).toBe(true);
    expect(
      allowedOriginsChanged(
        config({ serve: { allowedOrigins: ['http://a', 'http://b'] } }),
        config({ serve: { allowedOrigins: ['http://b', 'http://a'] } }),
      ),
    ).toBe(false);
    expect(allowedOriginsChanged(config(), config({ serve: {} }))).toBe(true);
  });
});

describe('createGatewayReload - plugins', () => {
  it('只刷新扫描缓存，不读配置', async () => {
    const d = deps();
    const reload = createGatewayReload(d);
    expect(await reload(['plugins'])).toEqual({ reloaded: ['plugins'], requires_restart: [] });
    expect(d.refreshCount()).toBe(1);
    expect(d.loadCount()).toBe(0);
  });
});

describe('createGatewayReload - config', () => {
  it('无变化：config 视为已重载', async () => {
    const d = deps();
    expect(await createGatewayReload(d)(['config'])).toEqual({
      reloaded: ['config'],
      requires_restart: [],
    });
    expect(d.loadCount()).toBe(1);
  });

  it('allowed_origins 变化且 web 有 reconfigure：调用并标记已重载', async () => {
    const calls: Array<{ allowedOrigins?: string[] }> = [];
    const gateway: GatewayReconfigureTarget = {
      reconfigure: async (options) => {
        calls.push(options);
      },
    };
    const d = deps({
      gateway: () => gateway,
      next: config({ serve: { allowedOrigins: ['http://new.example'] } }),
    });
    const result = await createGatewayReload(d)(['config']);
    expect(calls).toEqual([{ allowedOrigins: ['http://new.example'] }]);
    expect(result).toEqual({ reloaded: ['config'], requires_restart: [] });
  });

  it('allowed_origins 变化但 web 无 reconfigure：不假装成功', async () => {
    const d = deps({
      next: config({ serve: { allowedOrigins: ['http://new.example'] } }),
    });
    const result = await createGatewayReload(d)(['config']);
    expect(result.reloaded).toEqual([]);
    expect(result.requires_restart).toEqual(['serve.allowedOrigins']);
  });

  it('provider/model/port 等变化进入 requires_restart', async () => {
    const d = deps({
      next: config({
        provider: { name: 'anthropic', model: 'claude', apiKey: 'k' },
        serve: { allowedOrigins: ['http://a.example'], port: 9999 },
      }),
    });
    const result = await createGatewayReload(d)(['config']);
    expect(result.reloaded).toEqual(['config']);
    expect(result.requires_restart).toEqual(['provider', 'model', 'port']);
  });

  it('配置读取失败：抛错而不是返回成功', async () => {
    const d = deps({
      reloadConfig: async () => {
        throw new Error('yaml parse error');
      },
    });
    await expect(createGatewayReload(d)(['config'])).rejects.toThrow(
      'config_reload_failed: yaml parse error',
    );
  });

  it('reconfigure 抛错：向上抛，不吞掉', async () => {
    const d = deps({
      gateway: () => ({
        reconfigure: () => {
          throw new Error('bind failed');
        },
      }),
      next: config({ serve: { allowedOrigins: ['http://new.example'] } }),
    });
    await expect(createGatewayReload(d)(['config'])).rejects.toThrow('bind failed');
  });

  it('空 scopes 等价 config + plugins', async () => {
    const d = deps();
    const result = await createGatewayReload(d)([]);
    expect(result.reloaded).toEqual(['config', 'plugins']);
    expect(d.refreshCount()).toBe(1);
  });

  it('未知 scope 报错', async () => {
    await expect(createGatewayReload(deps())(['nope'])).rejects.toThrow('unknown reload scope');
  });
});
