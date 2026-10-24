import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { resolveConnectToken, resolveGatewayToken } from '../transport-factory';

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

describe('resolveGatewayToken', () => {
  it('serve.token > admin_token > env > transport.token；不含 serve.tokens', () => {
    expect(resolveGatewayToken({}, {})).toBeUndefined();

    expect(
      resolveGatewayToken(
        {
          serve: { token: 'serve-token', adminToken: 'admin-token' },
          transport: { token: 'transport-token' },
        },
        { VESSEL_GATEWAY_TOKEN: 'env-token' },
      ),
    ).toBe('serve-token');

    expect(
      resolveGatewayToken(
        { serve: { adminToken: 'admin-token' }, transport: { token: 'transport-token' } },
        { VESSEL_GATEWAY_TOKEN: 'env-token' },
      ),
    ).toBe('admin-token');

    expect(
      resolveGatewayToken(
        { transport: { token: 'transport-token' } },
        { VESSEL_GATEWAY_TOKEN: 'env-token' },
      ),
    ).toBe('env-token');

    expect(resolveGatewayToken({ transport: { token: 'transport-token' } }, {})).toBe(
      'transport-token',
    );

    // serve.tokens 是客户端凭据，绝不能当 gateway token。
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
    ).toBeUndefined();
  });
});

describe('resolveConnectToken (0.18)', () => {
  it('只配 serve.admin_token 时 connect 目标仍能取到凭据', () => {
    expect(resolveConnectToken({ serve: { adminToken: 'admin-token' } }, { env: {} })).toBe(
      'admin-token',
    );
    expect(
      resolveConnectToken(
        { serve: { adminTokenEnv: 'CP_ADMIN_TOKEN' } },
        { env: { CP_ADMIN_TOKEN: 'admin-from-env' } },
      ),
    ).toBe('admin-from-env');
  });

  it('只配 serve.token_env 时 connect 目标从 env 取到 token', () => {
    expect(
      resolveConnectToken(
        { serve: { tokenEnv: 'CP_GATEWAY_TOKEN' } },
        { env: { CP_GATEWAY_TOKEN: 'gateway-from-env' } },
      ),
    ).toBe('gateway-from-env');
    // env 变量未设置时不得把变量名当 token。
    expect(resolveConnectToken({ serve: { tokenEnv: 'CP_GATEWAY_TOKEN' } }, { env: {} })).toBe(
      undefined,
    );
  });

  it('connect.token 覆盖 serve.token；VESSEL_CONNECT_TOKEN 覆盖 connect.token', () => {
    const config: VesselConfig = {
      connect: { token: 'connect-token' },
      serve: { token: 'serve-token' },
      transport: { token: 'transport-token' },
    };
    expect(resolveConnectToken(config, { env: {} })).toBe('connect-token');
    expect(
      resolveConnectToken(config, { env: { VESSEL_CONNECT_TOKEN: 'connect-env-token' } }),
    ).toBe('connect-env-token');
    expect(
      resolveConnectToken(config, {
        connectToken: 'explicit-token',
        env: { VESSEL_CONNECT_TOKEN: 'connect-env-token' },
      }),
    ).toBe('explicit-token');
    // 空串视为未设置，继续回退。
    expect(resolveConnectToken(config, { connectToken: '', env: {} })).toBe('connect-token');
  });

  it('serve.tokens 永不被当作 gateway token', () => {
    expect(
      resolveConnectToken(
        {
          serve: {
            tokens: {
              'read-token': { role: 'read' },
              'write-token': { role: 'write', tenantId: 'default' },
            },
          },
        },
        { env: {} },
      ),
    ).toBeUndefined();
  });
});
