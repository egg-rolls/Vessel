import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway, TestWs } from './helpers';

const gateways: Gateway[] = [];
const clients: TestWs[] = [];

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: '*', role: 'admin' },
    a: { tenant_id: 'a', role: 'write' },
    b: { tenant_id: 'b', role: 'write' },
    d: { tenant_id: 'default', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function publish(events: MemoryEventStream, type: string, extra: Record<string, unknown> = {}) {
  events.publish({ type, run_id: 'r1', data: {}, ts: Date.now(), ...extra } as RunEvent);
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const gw of gateways.splice(0)) gw.stop();
});

function wsAttempt(url: string): Promise<'open' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: 'open' | 'error' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done('timeout'), 1_500);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      done('error');
      return;
    }
    ws.addEventListener('open', () => {
      done('open');
      ws.close();
    });
    ws.addEventListener('error', () => done('error'));
    ws.addEventListener('close', () => done('error'));
  });
}

describe('WS auth transport', () => {
  it('rejects token in query for both /v1/events and /ws', async () => {
    const events = new MemoryEventStream();
    const gw = createGateway({ events });
    gateways.push(gw);
    for (const path of ['/v1/events', '/ws']) {
      expect(await wsAttempt(`${gw.url.replace(/^http/, 'ws')}${path}?token=${gw.token}`)).toBe(
        'error',
      );
    }
  });
});

describe('WS tenant override', () => {
  const setup = () => {
    const events = new MemoryEventStream();
    const gw = createGateway({ events, auth: authFor() });
    gateways.push(gw);
    return { events, gw };
  };

  const connect = async (
    gw: Gateway,
    opts: { token: string; tenantId?: string },
  ): Promise<TestWs> => {
    const client = await TestWs.connect(gw, opts);
    clients.push(client);
    return client;
  };

  it('lets an admin override tenant in the auth frame', async () => {
    const { events, gw } = setup();
    const client = await connect(gw, { token: 'admin', tenantId: 'a' });
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.tenant_id).toBe('a');

    publish(events, 'demo.a', { tenant_id: 'a' });
    publish(events, 'demo.b', { tenant_id: 'b' });
    const frame = await client.next(
      (candidate) => candidate.kind === 'event' && candidate.event.type === 'demo.a',
    );
    if (frame.kind !== 'event') throw new Error('expected event');
    expect(frame.event.type).toBe('demo.a');

    await expect(
      client.next(
        (candidate) => candidate.kind === 'event' && candidate.event.type === 'demo.b',
        150,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-admin cross-tenant auth with 4403', async () => {
    const { gw } = setup();
    const client = await connect(gw, { token: 'b', tenantId: 'a' });
    expect(await client.closed()).toBe(4403);
  });

  it('accepts a non-admin matching tenant', async () => {
    const { gw } = setup();
    const client = await connect(gw, { token: 'b', tenantId: 'b' });
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.tenant_id).toBe('b');
  });

  it('lets an admin override tenant through events.subscribe', async () => {
    const { events, gw } = setup();
    const client = await connect(gw, { token: 'admin' });
    await client.request('events.subscribe', { since: 0, tenant_id: 'a' });

    publish(events, 'demo.a', { tenant_id: 'a' });
    publish(events, 'demo.b', { tenant_id: 'b' });
    const frame = await client.next(
      (candidate) => candidate.kind === 'event' && candidate.event.type === 'demo.a',
    );
    if (frame.kind !== 'event') throw new Error('expected event');
    expect(frame.event.type).toBe('demo.a');

    await expect(
      client.next(
        (candidate) => candidate.kind === 'event' && candidate.event.type === 'demo.b',
        150,
      ),
    ).rejects.toThrow();
  });

  it('rejects non-admin cross-tenant events.subscribe with forbidden', async () => {
    const { events, gw } = setup();
    const client = await connect(gw, { token: 'b' });
    const id = crypto.randomUUID();
    client.ws.send(
      JSON.stringify({
        v: 1,
        kind: 'req',
        id,
        method: 'events.subscribe',
        params: { since: 0, tenant_id: 'a' },
      }),
    );
    const frame = await client.next((candidate) => candidate.kind === 'res' && candidate.id === id);
    if (frame.kind !== 'res') throw new Error('expected res');
    expect(frame.ok).toBe(false);
    if (frame.ok) throw new Error('expected error');
    expect(frame.error.code).toBe('forbidden');

    // 失败不改变订阅 tenant：仍能收到本 tenant 事件。
    publish(events, 'demo.b', { tenant_id: 'b' });
    await client.next((candidate) => candidate.kind === 'event');
  });

  it('uses event.node_id for the event frame when present', async () => {
    const { events, gw } = setup();
    const client = await connect(gw, { token: 'admin' });

    publish(events, 'demo.local');
    const local = await client.next((candidate) => candidate.kind === 'event');
    if (local.kind !== 'event') throw new Error('expected event');
    expect(local.node_id).toBe(gw.nodeId);

    publish(events, 'demo.remote', { node_id: 'B' });
    const remote = await client.next(
      (candidate) => candidate.kind === 'event' && candidate.event.type === 'demo.remote',
    );
    if (remote.kind !== 'event') throw new Error('expected event');
    expect(remote.node_id).toBe('B');
  });
});
