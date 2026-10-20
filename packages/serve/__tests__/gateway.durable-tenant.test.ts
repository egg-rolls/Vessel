import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { DurableCheckpointLike, DurableStoreLike } from '../src/durable';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway } from './helpers';

interface FakeStore extends DurableStoreLike {
  calls: number;
  checkpoints: Map<string, DurableCheckpointLike>;
}

function makeStore(prefix: string): FakeStore {
  const store: FakeStore = {
    calls: 0,
    checkpoints: new Map(),
    async load(runId) {
      return store.checkpoints.get(runId) ?? null;
    },
    async list() {
      store.calls += 1;
      return [...store.checkpoints.values()];
    },
  };
  for (const runId of [`${prefix}-interrupted`, `${prefix}-done`]) {
    store.checkpoints.set(runId, {
      run_id: runId,
      session_id: 's1',
      status: runId.endsWith('done') ? 'completed' : 'interrupted',
      updated_at: 1000,
      messages: [{ role: 'assistant', content: runId }],
      tenant_id: prefix,
    });
  }
  return store;
}

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: '*', role: 'admin' },
    a: { tenant_id: 'a', role: 'admin' },
    b: { tenant_id: 'b', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

interface Harness {
  gateway: Gateway;
  defaultStore: FakeStore;
  bStore: FakeStore;
  resumed: string[];
}

const gateways: Gateway[] = [];

function start(): Harness {
  const defaultStore = makeStore('default');
  const bStore = makeStore('b');
  const resumed: string[] = [];
  const gateway = createGateway({
    events: new MemoryEventStream(),
    token: 'legacy',
    auth: authFor(),
    durable: {
      store: defaultStore,
      resume: (runId) => {
        resumed.push(runId);
      },
    },
    durableFor: (tenantId) =>
      tenantId === 'b'
        ? {
            store: bStore,
            resume: (runId) => {
              resumed.push(runId);
            },
          }
        : undefined,
  });
  gateways.push(gateway);
  return { gateway, defaultStore, bStore, resumed };
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

describe('durable REST tenant scope', () => {
  it('lets a wildcard admin list a non-default tenant via query', async () => {
    const { gateway, defaultStore, bStore } = start();

    const response = await fetch(`${gateway.url}/v1/durable/runs?tenant_id=b`, {
      headers: headers('admin'),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ run_id: string }> };
    expect(body.runs.map((run) => run.run_id).sort()).toEqual(['b-done', 'b-interrupted']);
    expect(bStore.calls).toBe(1);
    expect(defaultStore.calls).toBe(0);
  });

  it('accepts the tenant through the X-Vessel-Tenant header on resume', async () => {
    const { gateway, bStore, resumed } = start();

    const response = await fetch(`${gateway.url}/v1/durable/runs/b-interrupted/resume`, {
      method: 'POST',
      headers: headers('admin', { 'X-Vessel-Tenant': 'b' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run_id: 'b-interrupted', status: 'queued' });
    expect(resumed).toEqual(['b-interrupted']);
    expect(bStore.calls).toBe(0);
  });

  it('keeps the principal scope when no explicit tenant is given', async () => {
    const { gateway, defaultStore, bStore } = start();

    const adminResponse = await fetch(`${gateway.url}/v1/durable/runs`, {
      headers: headers('admin'),
    });
    expect(adminResponse.status).toBe(200);
    expect(defaultStore.calls).toBe(1);

    const tenantResponse = await fetch(`${gateway.url}/v1/durable/runs`, {
      headers: headers('b'),
    });
    expect(tenantResponse.status).toBe(200);
    expect(bStore.calls).toBe(1);
  });

  it('lets a tenant-scoped admin cross tenants', async () => {
    const { gateway, bStore } = start();

    const response = await fetch(`${gateway.url}/v1/durable/runs?tenant_id=b`, {
      headers: headers('a'),
    });
    expect(response.status).toBe(200);
    expect(bStore.calls).toBe(1);
  });

  it('rejects cross-tenant access for non-admin principals', async () => {
    const { gateway, defaultStore, bStore } = start();

    const response = await fetch(`${gateway.url}/v1/durable/runs?tenant_id=default`, {
      headers: headers('b'),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('forbidden');
    expect(defaultStore.calls).toBe(0);
    expect(bStore.calls).toBe(0);
  });

  it('rejects a conflicting query/header tenant and invalid ids', async () => {
    const { gateway } = start();

    const conflict = await fetch(`${gateway.url}/v1/durable/runs?tenant_id=b`, {
      headers: headers('admin', { 'X-Vessel-Tenant': 'default' }),
    });
    expect(conflict.status).toBe(400);
    expect(await errorCode(conflict)).toBe('invalid_request');

    const invalid = await fetch(`${gateway.url}/v1/durable/runs?tenant_id=Not_Valid`, {
      headers: headers('admin'),
    });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe('invalid_request');
  });
});
