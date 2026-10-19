import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { Transport } from '../../packages/core/src/index';
import {
  type LoopbackTransportOptionsLike,
  resolveGatewayToken,
  resolvePeersDir,
  tryCreateConfiguredTransport,
  tryCreateLoopbackTransport,
  tryCreateRemoteTransport,
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
  it('legacy > env > admin > tokens（与 gateway 鉴权一致）', () => {
    expect(resolveGatewayToken({}, {})).toBeUndefined();

    expect(resolveGatewayToken({ serve: { token: 'serve-token' } }, {})).toBe('serve-token');
    expect(
      resolveGatewayToken({ serve: { tokenEnv: 'SERVE_TOKEN' } }, { SERVE_TOKEN: 'env-serve' }),
    ).toBe('env-serve');
    expect(
      resolveGatewayToken(
        { transport: { token: 'config-token' } },
        {
          VESSEL_GATEWAY_TOKEN: 'env-token',
        },
      ),
    ).toBe('config-token');
    expect(resolveGatewayToken({}, { VESSEL_GATEWAY_TOKEN: 'env-token' })).toBe('env-token');
    expect(resolveGatewayToken({ serve: { adminToken: 'admin-token' } }, {})).toBe('admin-token');
    expect(
      resolveGatewayToken(
        {
          serve: {
            tokens: {
              'read-token': { role: 'read' },
              'write-token': { role: 'write', tenantId: 'default' },
            },
          },
        },
        {},
      ),
    ).toBe('write-token');
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

  it('透传 agents 回调（P1-1 短 id 远端发现）', async () => {
    let captured: LoopbackTransportOptionsLike | undefined;
    const agents = () => [{ id: 'worker', state: 'idle' as const, toolNames: [] }];
    const result = await tryCreateLoopbackTransport({
      config: baseConfig,
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      gatewayToken: 't',
      agents,
      loadModule: async () => ({
        createLoopbackTransport: async (options) => {
          captured = options;
          return fakeTransport();
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(captured?.agents).toBe(agents);
  });

  it('未提供 agents 时不下发该键', async () => {
    let captured: LoopbackTransportOptionsLike | undefined;
    await tryCreateLoopbackTransport({
      config: baseConfig,
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      gatewayToken: 't',
      loadModule: async () => ({
        createLoopbackTransport: async (options) => {
          captured = options;
          return fakeTransport();
        },
      }),
    });
    expect(captured && 'agents' in captured).toBe(false);
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

describe('remote transport factory (0.6)', () => {
  const nodes = [{ id: 'node-b', url: 'https://b.example.com', token: 'tok-b' }];
  const noopFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

  it('builds kind=remote via configured dispatcher', async () => {
    const remote = await tryCreateRemoteTransport({
      config: { transport: { kind: 'remote', nodes } },
      nodeId: 'node-a',
      fetch: noopFetch,
      heartbeatMs: 0,
    });
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.transport.kind).toBe('remote');
      expect(remote.transport.nodeId).toBe('node-a');
      expect(typeof remote.transport.request).toBe('function');
      await remote.transport.close();
    }

    const configured = await tryCreateConfiguredTransport({
      config: { transport: { kind: 'remote', nodes } },
      nodeId: 'node-a',
      endpoint: 'http://127.0.0.1:1',
      fetch: noopFetch,
      heartbeatMs: 0,
    });
    expect(configured.ok).toBe(true);
    if (configured.ok) {
      expect(configured.transport.kind).toBe('remote');
      await configured.transport.close();
    }
  });

  it('returns ok:false when nodes are missing', async () => {
    const result = await tryCreateRemoteTransport({
      config: { transport: { kind: 'remote' } },
      nodeId: 'node-a',
      fetch: noopFetch,
      heartbeatMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('transport.nodes');
  });
});
