import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

const fakeStore = {
  load: async () => null,
  list: async () => [],
};

describe('gateway remote listen', () => {
  const gateways: Gateway[] = [];

  const track = (gw: Gateway): Gateway => {
    gateways.push(gw);
    return gw;
  };

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('defaults to loopback and keeps /v1/health public', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));
    expect(gw.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(gw.tls).toBe(false);

    const res = await fetch(`${gw.url}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol: { features: string[] } };
    expect(body.protocol.features).toContain('runs.async');
    expect(body.protocol.features).not.toContain('tls');
  });

  it('rejects a non-loopback hostname without allowRemote', () => {
    expect(() => createGateway({ events: new MemoryEventStream(), hostname: '0.0.0.0' })).toThrow(
      /allow_remote/,
    );
  });

  it('rejects an explicitly empty token in remote mode', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: '',
      }),
    ).toThrow(/non-empty gateway token/);
  });

  it('generates a non-empty token when remote mode omits the token', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
      }),
    );
    expect(gw.token.length).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
    expect(res.status).toBe(200);
  });

  it('requires a token on /v1/health in remote mode, but not on /health', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        allowRemote: true,
        token: 'remote-secret',
      }),
    );

    const denied = await fetch(`${gw.url}/v1/health`);
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('unauthorized');

    const viaHeader = await fetch(`${gw.url}/v1/health`, {
      headers: { Authorization: 'Bearer remote-secret' },
    });
    expect(viaHeader.status).toBe(200);

    const viaQuery = await fetch(`${gw.url}/v1/health?token=remote-secret`);
    expect(viaQuery.status).toBe(200);

    const legacy = await fetch(`${gw.url}/health`);
    expect(legacy.status).toBe(200);
  });

  it('requires a token on durable and MCP endpoints in remote mode', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        allowRemote: true,
        token: 'remote-secret',
        durable: { store: fakeStore },
        mcp: { listServers: () => [] },
      }),
    );

    for (const path of ['/v1/durable/runs', '/v1/mcp/servers']) {
      const res = await fetch(`${gw.url}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('keeps Origin rules unchanged', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        allowedOrigins: ['http://localhost:5173'],
      }),
    );

    const denied = await fetch(`${gw.url}/v1/health`, {
      headers: { Origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'forbidden_origin',
    );

    const allowed = await fetch(`${gw.url}/v1/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(200);
  });

  it('keeps Host validation for concrete bindings', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));

    const denied = await fetch(`${gw.url}/v1/health`, {
      headers: { Host: 'evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('invalid_host');
  });

  it('accepts wildcard bindings with allowRemote', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: 'remote-secret',
      }),
    );

    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/health`, {
      headers: { Authorization: 'Bearer remote-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects hostnames that contain a path or scheme', () => {
    expect(() =>
      createGateway({ events: new MemoryEventStream(), hostname: 'http://127.0.0.1' }),
    ).toThrow(/bare host/);
  });
});
