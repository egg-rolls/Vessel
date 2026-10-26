import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway, GatewayReloadResult } from '../src/gateway';
import { RELOAD_SCOPES } from '../src/gateway/methods/admin';
import type { GatewayAuthLike } from '../src/tenant';
import { startTestGateway as startGateway } from './helpers';

const gateways: Gateway[] = [];
const previousFlag = process.env.VESSEL_VALIDATE_RESULTS;

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
  if (previousFlag === undefined) delete process.env.VESSEL_VALIDATE_RESULTS;
  else process.env.VESSEL_VALIDATE_RESULTS = previousFlag;
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: 'default', role: 'admin' },
    writer: { tenant_id: 'default', role: 'write' },
    reader: { tenant_id: 'default', role: 'read' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function startReloadGateway(reload?: (scopes: string[]) => Promise<GatewayReloadResult>): Gateway {
  const gateway = startGateway({
    events: new MemoryEventStream(),
    port: 0,
    token: 'legacy',
    auth: authFor(),
    ...(reload ? { reload } : {}),
  });
  gateways.push(gateway);
  return gateway;
}

async function rpc(
  gateway: Gateway,
  token: string,
  params?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      method: 'gateway.reload',
      ...(params !== undefined ? { params } : {}),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function errorOf(body: Record<string, unknown>): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return body.error as { code: string; message: string; details?: Record<string, unknown> };
}

describe('gateway.reload', () => {
  it('is admin-only: read and write tokens are forbidden', async () => {
    const calls: string[][] = [];
    const gateway = startReloadGateway(async (scopes) => {
      calls.push(scopes);
      return { reloaded: scopes, requires_restart: [] };
    });

    for (const token of ['reader', 'writer']) {
      const { status, body } = await rpc(gateway, token, { scopes: ['config'] });
      // A-3 §10.2：方法级错误仍是 HTTP 200 + ok:false。
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(errorOf(body).code).toBe('forbidden');
      expect(errorOf(body).details).toMatchObject({
        method: 'gateway.reload',
        required: 'admin',
      });
    }
    expect(calls).toEqual([]);
  });

  it('returns not_supported when no reload implementation is injected', async () => {
    const gateway = startReloadGateway();
    const { status, body } = await rpc(gateway, 'admin', { scopes: ['config'] });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(errorOf(body).code).toBe('not_supported');
    expect(errorOf(body).message).toContain('not supported');
  });

  it('passes explicit scopes through (deduped) and returns the injected result', async () => {
    const calls: string[][] = [];
    const gateway = startReloadGateway(async (scopes) => {
      calls.push(scopes);
      return { reloaded: ['config'], requires_restart: ['provider', 'tls'] };
    });

    const { body } = await rpc(gateway, 'admin', { scopes: ['plugins', 'config', 'plugins'] });
    expect(body.ok).toBe(true);
    expect(calls).toEqual([['plugins', 'config']]);
    expect(body.result).toEqual({
      reloaded: ['config'],
      requires_restart: ['provider', 'tls'],
    });
  });

  it('defaults to all hot-reloadable scopes when scopes is omitted', async () => {
    const calls: string[][] = [];
    const gateway = startReloadGateway(async (scopes) => {
      calls.push(scopes);
      return { reloaded: scopes, requires_restart: [] };
    });

    const { body } = await rpc(gateway, 'admin');
    expect(body.ok).toBe(true);
    // 跟随 RELOAD_SCOPES 常量，而不是在测试里再抄一份清单。
    const expected = [...RELOAD_SCOPES];
    expect(calls).toEqual([expected]);
    expect(body.result).toEqual({ reloaded: expected, requires_restart: [] });
  });

  it('accepts each of the extended scopes', async () => {
    const calls: string[][] = [];
    const gateway = startReloadGateway(async (scopes) => {
      calls.push(scopes);
      return { reloaded: scopes, requires_restart: [] };
    });

    const { body } = await rpc(gateway, 'admin', {
      scopes: ['permission', 'tools', 'mcp'],
    });
    expect(body.ok).toBe(true);
    expect(calls).toEqual([['permission', 'tools', 'mcp']]);
  });

  it('rejects unknown or non-array scopes with invalid_params', async () => {
    const gateway = startReloadGateway(async (scopes) => ({
      reloaded: scopes,
      requires_restart: [],
    }));

    for (const params of [{ scopes: ['secrets'] }, { scopes: 'config' }]) {
      const { status, body } = await rpc(gateway, 'admin', params);
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(errorOf(body).code).toBe('invalid_params');
    }
  });

  it('validates the result shape when VESSEL_VALIDATE_RESULTS=1', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const gateway = startReloadGateway(async () => ({
      reloaded: ['config'],
      requires_restart: [],
    }));

    const good = await rpc(gateway, 'admin', { scopes: ['config'] });
    expect(good.body.ok).toBe(true);
    expect(good.body.result).toEqual({ reloaded: ['config'], requires_restart: [] });

    const bad = startReloadGateway(
      async () => ({ reloaded: ['config'] }) as unknown as GatewayReloadResult,
    );
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const invalid = await rpc(bad, 'admin', { scopes: ['config'] });
    warn.mockRestore();
    expect(invalid.body.ok).toBe(false);
    expect(errorOf(invalid.body).code).toBe('internal');
    expect(errorOf(invalid.body).details).toEqual({
      method: 'gateway.reload',
      path: 'result.requires_restart',
    });
  });

  it('advertises admin permission and a result schema in the manifest', () => {
    const gateway = startReloadGateway();
    const method = gateway
      .manifest()
      .methods.find((candidate) => candidate.name === 'gateway.reload');
    expect(method).toBeDefined();
    expect(method?.permission).toBe('admin');
    expect(method?.result_schema).toBeDefined();
    expect(method?.params_schema).toBeDefined();
  });
});
