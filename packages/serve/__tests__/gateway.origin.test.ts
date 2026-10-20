import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream } from '@vessel-agent/core';
import { type Gateway, normalizeAllowedOrigins } from '../src/gateway';
import { createGateway } from './helpers';

const ALLOWED = 'https://console.example.com';

function track(list: Gateway[], gw: Gateway): Gateway {
  list.push(gw);
  return gw;
}

/** Bun WebSocket 客户端支持 headers，用来验证 upgrade 前的 Origin allowlist。 */
function wsAttempt(url: string, origin: string): Promise<'open' | 'error'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: 'open' | 'error') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done('error'), 3_000);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
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

describe('normalizeAllowedOrigins', () => {
  it('normalizes and dedupes exact origins', () => {
    expect(
      normalizeAllowedOrigins(['HTTP://LocalHost:5173/', 'http://localhost:5173', `${ALLOWED}/`]),
    ).toEqual(['http://localhost:5173', ALLOWED]);
  });

  it('rejects wildcard, paths, query strings and non-http schemes', () => {
    for (const value of [
      '*',
      '',
      'https://console.example.com/app',
      'https://console.example.com?x=1',
      'https://console.example.com#top',
      'ftp://console.example.com',
      'not-a-url',
    ]) {
      expect(() => normalizeAllowedOrigins([value])).toThrow();
    }
  });

  it('rejects wildcard at gateway startup', () => {
    expect(() => createGateway({ events: new MemoryEventStream(), allowedOrigins: ['*'] })).toThrow(
      /wildcard/,
    );
  });
});

describe('gateway Origin/CORS policy', () => {
  const gateways: Gateway[] = [];

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('answers preflight 204 with CORS headers only for allowed origins', async () => {
    const gw = track(
      gateways,
      createGateway({
        events: new MemoryEventStream(),
        allowedOrigins: ['http://localhost:5173/'],
      }),
    );

    const allowed = await fetch(`${gw.url}/v1/rpc`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(allowed.headers.get('access-control-max-age')).toBe('600');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    expect(allowed.headers.get('vary')).toBe('Origin');

    const denied = await fetch(`${gw.url}/v1/rpc`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.headers.get('vary')).toBe('Origin');
  });

  it('adds ACAO and Vary to success and error responses when allowed', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );

    const ok = await fetch(`${gw.url}/v1/health`, { headers: { Origin: ALLOWED } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(ok.headers.get('vary')).toBe('Origin');

    const unauthorized = await fetch(`${gw.url}/v1/sessions`, {
      headers: { Origin: ALLOWED },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(unauthorized.headers.get('vary')).toBe('Origin');
  });

  it('keeps CORS headers on request-body validation errors', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );
    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: {
        Origin: ALLOWED,
        Authorization: `Bearer ${gw.token}`,
        'Content-Type': 'text/plain',
      },
      body: 'not json',
    });
    expect(res.status).toBe(415);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('rejects disallowed origins with 403 and keeps Vary for caches', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );

    const denied = await fetch(`${gw.url}/v1/health`, {
      headers: { Origin: 'http://evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.headers.get('vary')).toBe('Origin');
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_origin');
  });

  it('allows same-origin requests without the allowlist', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );
    const res = await fetch(`${gw.url}/v1/health`, { headers: { Origin: gw.url } });
    expect(res.status).toBe(200);
  });

  it('applies the Origin allowlist before WebSocket upgrade', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );
    const wsUrl = `${gw.url.replace(/^http/, 'ws')}/v1/events?since=0`;

    expect(await wsAttempt(wsUrl, 'http://evil.example')).toBe('error');
    expect(await wsAttempt(wsUrl, ALLOWED)).toBe('open');
  });
});

describe('gateway CSP', () => {
  let staticDir: string;
  const gateways: Gateway[] = [];

  beforeAll(async () => {
    staticDir = await mkdtemp(join(tmpdir(), 'vessel-gw-csp-'));
    await mkdir(join(staticDir, 'assets'), { recursive: true });
    await writeFile(
      join(staticDir, 'index.html'),
      '<!doctype html><html><body><div id="root">vessel</div></body></html>',
      'utf8',
    );
    await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("vessel");', 'utf8');
  });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  afterAll(async () => {
    await rm(staticDir, { recursive: true, force: true });
  });

  it('derives connect-src from Host and allowed origins without wildcards', async () => {
    const gw = track(
      gateways,
      createGateway({
        events: new MemoryEventStream(),
        staticDir,
        allowedOrigins: [ALLOWED],
      }),
    );
    const host = new URL(gw.url).host;

    const res = await fetch(`${gw.url}/`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`connect-src 'self' ws://${host} ${ALLOWED} wss://console.example.com;`);
    expect(csp).not.toContain('ws: wss:');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('does not attach CSP to static assets', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), staticDir, allowedOrigins: [ALLOWED] }),
    );
    const res = await fetch(`${gw.url}/assets/app.js`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });
});
