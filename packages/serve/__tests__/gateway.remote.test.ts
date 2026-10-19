import { afterEach, describe, expect, it } from 'bun:test';
import { request as httpsRequestRaw } from 'node:https';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

const CERT = fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url));
const KEY = fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url));

const fakeStore = {
  load: async () => null,
  list: async () => [],
};

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequestRaw(
      url,
      { method: 'GET', headers, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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
        tls: { certFile: CERT, keyFile: KEY },
      }),
    ).toThrow(/non-empty gateway token/);
  });

  it('rejects non-loopback listeners without TLS', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: 'remote-secret',
      }),
    ).toThrow(/requires TLS/);
  });

  it('rejects non-loopback listeners with TLS but no explicit token', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        tls: { certFile: CERT, keyFile: KEY },
      }),
    ).toThrow(/explicit non-empty gateway token/);
  });

  it('starts non-loopback listeners with TLS and an explicit token', async () => {
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: 'remote-secret',
        tls: { certFile: CERT, keyFile: KEY },
      }),
    );
    expect(gw.tls).toBe(true);
    expect(gw.url.startsWith('https://0.0.0.0:')).toBe(true);

    const res = await httpsGet(`https://127.0.0.1:${gw.port}/v1/health`, {
      Authorization: 'Bearer remote-secret',
    });
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

  it('keeps Host validation for concrete bindings', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));

    const denied = await fetch(`${gw.url}/v1/health`, {
      headers: { Host: 'evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('invalid_host');
  });

  it('rejects hostnames that contain a path or scheme', () => {
    expect(() =>
      createGateway({ events: new MemoryEventStream(), hostname: 'http://127.0.0.1' }),
    ).toThrow(/bare host/);
  });
});
