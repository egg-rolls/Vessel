import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemorySessionBackend } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function track(gateway: Gateway): Gateway {
  gateways.push(gateway);
  return gateway;
}

describe('query token scope', () => {
  it('rejects ?token= on REST even when the query token is valid', async () => {
    const gateway = track(
      createGateway({ events: new MemoryEventStream(), session: new MemorySessionBackend() }),
    );
    const response = await fetch(`${gateway.url}/v1/sessions?token=${gateway.token}`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects ?token= on REST when a valid Bearer header is also present', async () => {
    const gateway = track(
      createGateway({ events: new MemoryEventStream(), session: new MemorySessionBackend() }),
    );
    const response = await fetch(`${gateway.url}/v1/sessions?token=${gateway.token}`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects ?token= on /v1/health in remote mode', async () => {
    const gateway = track(
      createGateway({
        events: new MemoryEventStream(),
        allowRemote: true,
        token: 'remote-secret',
      }),
    );
    const viaQuery = await fetch(`${gateway.url}/v1/health?token=remote-secret`);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await fetch(`${gateway.url}/v1/health`, {
      headers: { Authorization: 'Bearer remote-secret' },
    });
    expect(viaHeader.status).toBe(200);
  });

  it('keeps accepting the header token on REST', async () => {
    const gateway = track(
      createGateway({ events: new MemoryEventStream(), session: new MemorySessionBackend() }),
    );
    const response = await fetch(`${gateway.url}/v1/sessions`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(response.status).toBe(200);
  });

  it('allows ?token= on the SSE /v1/events stream only', async () => {
    const gateway = track(createGateway({ events: new MemoryEventStream() }));
    const response = await fetch(`${gateway.url}/v1/events?token=${gateway.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });
});
