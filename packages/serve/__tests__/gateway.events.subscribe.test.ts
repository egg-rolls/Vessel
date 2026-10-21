import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { toEventNotification } from '../src/rpc';
import type { GatewayAuthLike } from '../src/tenant';
import { sleep, startTestGateway as startGateway, TestWs } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    a: { tenant_id: 'a', role: 'write' },
    b: { tenant_id: 'b', role: 'write' },
    admin: { tenant_id: '*', role: 'admin' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function publish(events: MemoryEventStream, event: Partial<RunEvent> & { type: string }): void {
  events.publish({
    run_id: 'r1',
    data: {},
    ts: Date.now(),
    ...event,
  });
}

describe('outbound redaction', () => {
  it('redacts secrets before buffering and replay', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, token: 't' });
    gateways.push(gateway);
    const ws = await TestWs.connect(gateway);
    await ws.next((frame) => frame.kind === 'hello');

    publish(events, {
      type: 'llm.request',
      data: {
        api_key: 'sk-super-secret',
        authorization: 'Bearer abc',
        app_id: 'cli_12345678',
        usage: { total_tokens: 5 },
      },
    });

    const data = await ws.nextEvent('llm.request');
    expect(data.api_key).toBe('***');
    expect(data.authorization).toBe('***');
    expect(data.app_id).toBe('cli_***');
    expect((data.usage as { total_tokens: number }).total_tokens).toBe(5);

    const replay = await TestWs.connect(gateway, { since: 0 });
    const replayed = await replay.nextEvent('llm.request');
    expect(replayed.api_key).toBe('***');
    ws.close();
    replay.close();
  });
});

describe('tenant event filtering', () => {
  it('only delivers events for the principal tenant', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
    });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway, { token: 'a' });
    await client.next((frame) => frame.kind === 'hello');

    publish(events, { type: 'tenant.b', tenant_id: 'b' });
    publish(events, { type: 'tenant.a', tenant_id: 'a' });

    const received = await client.nextEvent('tenant.a');
    expect(received).toEqual({});
    await expect(
      client.next((frame) => frame.kind === 'event' && frame.event.type === 'tenant.b', 300),
    ).rejects.toThrow('Timed out');
    client.close();
  });

  it('lets a wildcard admin opt into all tenants', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, token: 'legacy', auth: authFor() });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway, { token: 'admin' });
    await client.next((frame) => frame.kind === 'hello');
    await client.request('events.subscribe', { all_tenants: true });

    publish(events, { type: 'tenant.b', tenant_id: 'b' });
    const received = await client.nextEvent('tenant.b');
    expect(received).toEqual({});
    client.close();
  });
});

describe('events.subscribe', () => {
  it('applies run_id and type filters to live events', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, token: 't' });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway);
    await client.next((frame) => frame.kind === 'hello');
    await client.request('events.subscribe', { run_id: 'r1', types: ['wanted'] });

    publish(events, { type: 'wanted', run_id: 'r1' });
    publish(events, { type: 'wanted', run_id: 'r2' });
    publish(events, { type: 'other', run_id: 'r1' });

    const received = await client.nextEvent('wanted');
    expect(received).toEqual({});
    await expect(
      client.next((frame) => frame.kind === 'event' && frame.event.run_id === 'r2', 300),
    ).rejects.toThrow('Timed out');
    client.close();
  });

  it('replays after the gateway wire seq', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, token: 't' });
    gateways.push(gateway);
    const first = await TestWs.connect(gateway);
    await first.next((frame) => frame.kind === 'hello');
    publish(events, { type: 'one' });
    const oneFrame = await first.next((frame) => frame.kind === 'event');
    if (oneFrame.kind !== 'event') throw new Error('expected event');
    const wireSeq = oneFrame.seq;
    first.close();

    publish(events, { type: 'two' });
    const second = await TestWs.connect(gateway, { since: wireSeq });
    const replayed = await second.next((frame) => frame.kind === 'event');
    if (replayed.kind !== 'event') throw new Error('expected event');
    expect(replayed.event.type).toBe('two');
    expect(replayed.seq).toBeGreaterThan(wireSeq);
    second.close();
  });
});

describe('events.list', () => {
  it('reads trace events and returns their core seq ordering', async () => {
    const events = new MemoryEventStream();
    let receivedFilter: Record<string, unknown> | undefined;
    const gateway = startGateway({
      events,
      port: 0,
      token: 't',
      trace: {
        readEvents: async (filter) => {
          receivedFilter = filter;
          return [
            { type: 'b', run_id: 'r1', data: {}, ts: 1, seq: 1 },
            { type: 'a', run_id: 'r1', data: {}, ts: 2, seq: 2 },
          ];
        },
      },
    });
    gateways.push(gateway);

    const response = await fetch(`${gateway.url}/v1/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: '1',
        method: 'events.list',
        params: { run_id: 'r1', since_seq: 0, limit: 10 },
      }),
    });
    const body = (await response.json()) as { ok: boolean; result: { events: RunEvent[] } };
    expect(body.ok).toBe(true);
    expect(receivedFilter).toEqual({ run_id: 'r1', since_seq: 0, limit: 10 });
    expect(body.result.events.map((event) => event.seq)).toEqual([1, 2]);

    const invalid = await fetch(`${gateway.url}/v1/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: '2',
        method: 'events.list',
        params: { types: ['a'], type_prefix: 'x' },
      }),
    });
    const invalidBody = (await invalid.json()) as { ok: boolean; error: { code: string } };
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.error.code).toBe('invalid_params');
  });

  it('exposes the RPC notification shape', () => {
    const event: RunEvent = { type: 'x', run_id: 'r', data: {}, ts: 1 };
    expect(toEventNotification(event)).toEqual({ method: 'events.event', params: event });
  });
});

describe('redaction edge cases', () => {
  it('does not leak secrets through the SSE log or frame', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, token: 't' });
    gateways.push(gateway);
    const ws = await TestWs.connect(gateway);
    await ws.next((frame) => frame.kind === 'hello');
    publish(events, { type: 'secret', data: { password: 'p', nested: { token: 't' } } });
    await sleep(20);
    const data = await ws.nextEvent('secret');
    expect(data.password).toBe('***');
    expect((data.nested as { token: string }).token).toBe('***');
    ws.close();
  });
});
