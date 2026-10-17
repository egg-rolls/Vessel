import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { Transport } from '../../packages/core/src/index';
import {
  type LoopbackTransportOptionsLike,
  resolveGatewayToken,
  resolvePeersDir,
  tryCreateLoopbackTransport,
} from '../transport-factory';

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

function fakeTransport(): Transport {
  const unsubscribe = () => {};
  return {
    kind: 'loopback',
    send: async () => {},
    receive: () => unsubscribe,
    peers: async () => [],
    close: async () => {},
  };
}

describe('resolvePeersDir', () => {
  it('缺省为 ~/.vessel/peers', () => {
    expect(resolvePeersDir()).toBe(path.join(os.homedir(), '.vessel', 'peers'));
  });

  it('展开 ~ 与 ~/', () => {
    expect(resolvePeersDir('~')).toBe(os.homedir());
    expect(resolvePeersDir('~/.vessel/test-peers')).toBe(
      path.join(os.homedir(), '.vessel', 'test-peers'),
    );
  });

  it('相对路径按 cwd 解析', () => {
    expect(resolvePeersDir('relative/peers')).toBe(path.resolve('relative/peers'));
  });
});

describe('resolveGatewayToken', () => {
  it('config > VESSEL_GATEWAY_TOKEN > undefined', () => {
    expect(resolveGatewayToken({})).toBeUndefined();

    process.env.VESSEL_GATEWAY_TOKEN = 'env-token';
    expect(resolveGatewayToken({})).toBe('env-token');

    expect(resolveGatewayToken({ transport: { token: 'config-token' } })).toBe('config-token');
  });
});

describe('tryCreateLoopbackTransport', () => {
  const baseConfig: VesselConfig = {
    transport: {
      kind: 'loopback',
      peersDir: '~/.vessel/test-peers',
      heartbeatMs: 1000,
      peerTtlMs: 3000,
    },
  };

  it('用 gateway 实际 endpoint 与回退 token 构造 transport', async () => {
    let captured: LoopbackTransportOptionsLike | undefined;
    const result = await tryCreateLoopbackTransport({
      config: baseConfig,
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:12345',
      gatewayToken: 'gateway-token',
      loadModule: async () => ({
        createLoopbackTransport: async (options) => {
          captured = options;
          return fakeTransport();
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(captured).toEqual({
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:12345',
      token: 'gateway-token',
      peersDir: path.join(os.homedir(), '.vessel', 'test-peers'),
      heartbeatMs: 1000,
      peerTtlMs: 3000,
    });
  });

  it('config token 优先于 gateway token', async () => {
    let captured: LoopbackTransportOptionsLike | undefined;
    await tryCreateLoopbackTransport({
      config: { transport: { token: 'config-token' } },
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      gatewayToken: 'gateway-token',
      loadModule: async () => ({
        createLoopbackTransport: async (options) => {
          captured = options;
          return fakeTransport();
        },
      }),
    });
    expect(captured?.token).toBe('config-token');
  });

  it('没有 token 时返回 ok:false（不构造）', async () => {
    const result = await tryCreateLoopbackTransport({
      config: {},
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('token');
  });

  it('web transport 加载失败时返回 ok:false', async () => {
    const result = await tryCreateLoopbackTransport({
      config: baseConfig,
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      gatewayToken: 't',
      loadModule: async () => {
        throw new Error('module unavailable');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('module unavailable');
  });

  it('createLoopbackTransport 抛错时返回 ok:false', async () => {
    const result = await tryCreateLoopbackTransport({
      config: baseConfig,
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      gatewayToken: 't',
      loadModule: async () => ({
        createLoopbackTransport: async () => {
          throw new Error('peers dir unwritable');
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('peers dir unwritable');
  });
});
