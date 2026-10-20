import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createRuntime } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authForB(): GatewayAuthLike {
  return {
    configured: true,
    authenticate: (token) => (token === 'b' ? { tenant_id: 'b', role: 'write' } : null),
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

describe('unconfigured non-default tenant', () => {
  it('returns forbidden for session and run entrypoints without per-tenant factories', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
    });
    gateways.push(gateway);

    const list = await rpc(gateway, 'b', 'sessions.list');
    expect(list.ok).toBe(false);
    expect(errorCode(list)).toBe('forbidden');

    const get = await rpc(gateway, 'b', 'sessions.get', { session_id: 's1' });
    expect(get.ok).toBe(false);
    expect(errorCode(get)).toBe('forbidden');

    const rename = await rpc(gateway, 'b', 'sessions.rename', {
      session_id: 's1',
      title: 'x',
    });
    expect(rename.ok).toBe(false);
    expect(errorCode(rename)).toBe('forbidden');

    const start = await rpc(gateway, 'b', 'runs.start', { input: 'x' });
    expect(start.ok).toBe(false);
    expect(errorCode(start)).toBe('forbidden');

    const tools = await rpc(gateway, 'b', 'tools.list');
    expect(tools.ok).toBe(false);
    expect(errorCode(tools)).toBe('forbidden');
  });

  it('keeps sessions forbidden when only runtimeFor is injected', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authForB(),
      runtimeFor: () => runtime,
    });
    gateways.push(gateway);

    const list = await rpc(gateway, 'b', 'sessions.list');
    expect(list.ok).toBe(false);
    expect(errorCode(list)).toBe('forbidden');

    const start = await rpc(gateway, 'b', 'runs.start', { input: 'hello' });
    expect(start.ok).toBe(true);
  });
});

describe('default tenant keeps legacy semantics', () => {
  it('keeps canonical sessions.list internal and legacy sessions invalid_request', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
    });
    gateways.push(gateway);

    const canonical = await rpc(gateway, 'legacy', 'sessions.list');
    expect(canonical.ok).toBe(false);
    expect(errorCode(canonical)).toBe('internal');

    const legacy = await fetch(`${gateway.url}/v1/sessions`, {
      headers: { Authorization: 'Bearer legacy' },
    });
    expect(legacy.status).toBe(400);
    const body = (await legacy.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('keeps legacy /v1/runs no_runtime at 400', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
    });
    gateways.push(gateway);

    const response = await fetch(`${gateway.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy', 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_runtime');
  });
});
