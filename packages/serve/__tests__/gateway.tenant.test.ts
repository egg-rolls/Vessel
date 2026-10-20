import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike, TenantControlLike, TenantInfo } from '../src/tenant';
import { QuotaExceededError } from '../src/tenant';
import { createRuntime, SlowProvider } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    a: { tenant_id: 'a', role: 'admin' },
    b: { tenant_id: 'b', role: 'write' },
    admin: { tenant_id: '*', role: 'admin' },
    q: { tenant_id: 'q', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

async function rpc(
  gateway: Gateway,
  token: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? '';
}

describe('tenant auth and isolation', () => {
  it('maps tokens to principals and isolates runs by tenant', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      runtimeFor: () => runtime,
    });
    gateways.push(gateway);

    const started = await rpc(gateway, 'a', 'runs.start', { input: 'hello-a' });
    expect(started.ok).toBe(true);

    const aList = await rpc(gateway, 'a', 'runs.list');
    const bList = await rpc(gateway, 'b', 'runs.list');
    expect((aList.result as { runs: unknown[] }).runs).toHaveLength(1);
    expect((bList.result as { runs: unknown[] }).runs).toHaveLength(0);

    const denied = await rpc(gateway, 'b', 'runs.start', { input: 'x', tenant_id: 'a' });
    expect(denied.ok).toBe(false);
    expect(errorCode(denied)).toBe('forbidden');
  });

  it('lets a wildcard admin target another tenant', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      runtimeFor: () => runtime,
      metrics: () => ({
        runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
        tool_calls: { total: 0, failed: 0 },
        llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        duration_ms: { total: 0, max: 0, avg: 0 },
        updated_at: 1,
      }),
    });
    gateways.push(gateway);

    const started = await rpc(gateway, 'admin', 'runs.start', { input: 'x', tenant_id: 'b' });
    expect(started.ok).toBe(true);
    const bList = await rpc(gateway, 'b', 'runs.list');
    expect((bList.result as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('returns forbidden for the non-default tenant when no factory is injected', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gateway = startGateway({ events, port: 0, token: 'legacy', auth: authFor(), runtime });
    gateways.push(gateway);

    const result = await rpc(gateway, 'b', 'runs.start', { input: 'x' });
    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('forbidden');
  });
});

describe('quota', () => {
  it('maps checkQuota failures to quota_exceeded without creating a run', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const tenants: TenantControlLike = {
      list: async () => [],
      get: async () => null,
      checkQuota: (tenantId, operation) => {
        if (tenantId === 'q' && operation === 'runs.start') {
          throw new QuotaExceededError('runs per day exceeded', { limit: 1 });
        }
      },
    };
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      runtimeFor: () => runtime,
      tenants,
    });
    gateways.push(gateway);

    const result = await rpc(gateway, 'q', 'runs.start', { input: 'x' });
    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('quota_exceeded');
    const list = await rpc(gateway, 'q', 'runs.list');
    expect((list.result as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it('enforces max_concurrent_runs before accepting another run', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(1500) });
    const info: TenantInfo = {
      tenant_id: 'c',
      status: 'active',
      created_at: 1,
      quota: { max_concurrent_runs: 1 },
    };
    const tenants: TenantControlLike = {
      list: async () => [info],
      get: async (id) => (id === 'c' ? info : null),
      checkQuota: () => {},
    };
    const auth: GatewayAuthLike = {
      configured: true,
      authenticate: (token) => (token === 'c' ? { tenant_id: 'c', role: 'write' } : null),
    };
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth,
      runtimeFor: () => runtime,
      tenants,
    });
    gateways.push(gateway);

    const first = await rpc(gateway, 'c', 'runs.start', { input: 'first' });
    expect(first.ok).toBe(true);
    const second = await rpc(gateway, 'c', 'runs.start', { input: 'second' });
    expect(second.ok).toBe(false);
    expect(errorCode(second)).toBe('quota_exceeded');
  });
});

describe('tenant registry and config', () => {
  it('restricts tenants.list to admins and tenants.get to the own tenant', async () => {
    const events = new MemoryEventStream();
    const entries: Record<string, TenantInfo> = {
      a: { tenant_id: 'a', status: 'active', created_at: 1 },
      b: { tenant_id: 'b', status: 'disabled', created_at: 2 },
    };
    const tenants: TenantControlLike = {
      list: async () => Object.values(entries),
      get: async (id) => entries[id] ?? null,
    };
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      tenants,
      config: {
        snapshot: (tenantId) => ({
          schema_version: 1,
          config: { tenant: tenantId },
          sources: {},
          tenant_id: tenantId,
        }),
      },
    });
    gateways.push(gateway);

    const denied = await rpc(gateway, 'b', 'tenants.list');
    expect(denied.ok).toBe(false);
    expect(errorCode(denied)).toBe('forbidden');

    const own = await rpc(gateway, 'b', 'tenants.get', { tenant_id: 'b' });
    expect((own.result as { tenant: TenantInfo }).tenant.status).toBe('disabled');
    const other = await rpc(gateway, 'b', 'tenants.get', { tenant_id: 'a' });
    expect(errorCode(other)).toBe('forbidden');

    const admin = await rpc(gateway, 'admin', 'tenants.list');
    expect((admin.result as { tenants: TenantInfo[] }).tenants).toHaveLength(2);

    const config = await rpc(gateway, 'b', 'config.get');
    expect((config.result as { tenant_id: string }).tenant_id).toBe('b');
  });

  it('maps deleteSessionData conflicts to conflict', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      sessionData: {
        deleteSessionData: async () => {
          throw Object.assign(new Error('session has running run'), { code: 'conflict' });
        },
      },
    });
    gateways.push(gateway);
    const result = await rpc(gateway, 'legacy', 'sessions.delete', { session_id: 's' });
    expect(result.ok).toBe(false);
    expect(errorCode(result)).toBe('conflict');
  });
});
