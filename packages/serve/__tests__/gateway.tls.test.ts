import { afterEach, describe, expect, it } from 'bun:test';
import { request as httpsRequestRaw } from 'node:https';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway, GatewayOptions } from '../src/gateway';
import { createGateway } from './helpers';

const CERT = fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url));
const KEY = fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url));

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

function wssHello(gw: Gateway, token: string): Promise<{ kind: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gw.url.replace(/^https/, 'wss')}/v1/events`, {
      tls: { rejectUnauthorized: false },
    } as never);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for hello over wss'));
    }, 3000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ v: 1, kind: 'auth', token }));
    });
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { kind?: string };
      if (frame.kind === 'hello') {
        clearTimeout(timer);
        ws.close();
        resolve(frame as { kind: string });
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('wss connection failed'));
    });
  });
}

describe('gateway TLS', () => {
  const gateways: Gateway[] = [];

  const tlsOptions = (): GatewayOptions['tls'] => ({ certFile: CERT, keyFile: KEY });

  const start = (overrides: Partial<GatewayOptions> = {}): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      tls: tlsOptions(),
      ...overrides,
    });
    gateways.push(gw);
    return gw;
  };

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('rejects a cert without a key', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        tls: { certFile: CERT } as unknown as GatewayOptions['tls'],
      }),
    ).toThrow(/both cert_file and key_file/);
  });

  it('rejects unreadable files with a path and error code', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        tls: { certFile: `${CERT}.missing`, keyFile: KEY },
      }),
    ).toThrow(/cert_file.*ENOENT/);
  });

  it('starts HTTPS on loopback without allowRemote and advertises tls', async () => {
    const gw = start();
    expect(gw.tls).toBe(true);
    expect(gw.url.startsWith('https://127.0.0.1:')).toBe(true);

    const health = await httpsGet(`${gw.url}/v1/health`);
    expect(health.status).toBe(200);
    const body = JSON.parse(health.body) as { protocol: { features: string[] } };
    expect(body.protocol.features).toContain('tls');

    const tools = await httpsGet(`${gw.url}/v1/tools`, {
      Authorization: `Bearer ${gw.token}`,
    });
    expect(tools.status).toBe(200);
  });

  it('serves the websocket event stream over wss', async () => {
    const gw = start();
    const hello = await wssHello(gw, gw.token);
    expect(hello.kind).toBe('hello');
  });

  it('requires allowRemote, TLS and an explicit token for non-loopback', () => {
    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        tls: tlsOptions(),
      }),
    ).toThrow(/allow_remote/);

    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: 'remote-secret',
      }),
    ).toThrow(/requires TLS/);

    expect(() =>
      createGateway({
        events: new MemoryEventStream(),
        hostname: '0.0.0.0',
        allowRemote: true,
        token: '',
        tls: tlsOptions(),
      }),
    ).toThrow(/non-empty gateway token/);
  });
});
