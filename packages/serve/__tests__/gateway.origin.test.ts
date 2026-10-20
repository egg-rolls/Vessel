import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream } from '@vessel-agent/core';
import { type Gateway, normalizeAllowedOrigins } from '../src/gateway';
import { createGateway, TestWs } from './helpers';

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

  it('reconfigure swaps the Origin allowlist for subsequent requests', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );
    const next = 'https://next.example.com';

    const before = await fetch(`${gw.url}/v1/health`, { headers: { Origin: ALLOWED } });
    expect(before.status).toBe(200);

    gw.reconfigure({ allowedOrigins: [next] });

    const oldDenied = await fetch(`${gw.url}/v1/health`, { headers: { Origin: ALLOWED } });
    expect(oldDenied.status).toBe(403);
    expect(oldDenied.headers.get('access-control-allow-origin')).toBeNull();

    const nextAllowed = await fetch(`${gw.url}/v1/health`, { headers: { Origin: next } });
    expect(nextAllowed.status).toBe(200);
    expect(nextAllowed.headers.get('access-control-allow-origin')).toBe(next);
    expect(nextAllowed.headers.get('vary')).toBe('Origin');
  });

  it('keeps the old allowlist when reconfigure input is invalid or omitted', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), allowedOrigins: [ALLOWED] }),
    );

    expect(() => gw.reconfigure({ allowedOrigins: ['*'] })).toThrow(/wildcard/);
    gw.reconfigure({});

    const res = await fetch(`${gw.url}/v1/health`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
  });

  it('does not rebuild existing WS/SSE connections when the allowlist changes', async () => {
    const events = new MemoryEventStream();
    const gw = track(gateways, createGateway({ events, allowedOrigins: [ALLOWED] }));
    const next = 'https://next.example.com';
    const wsUrl = `${gw.url.replace(/^http/, 'ws')}/v1/events?since=0`;

    const client = await TestWs.connect(gw, { origin: ALLOWED });
    const sseController = new AbortController();
    const sse = await fetch(`${gw.url}/v1/events?token=${gw.token}&since=0`, {
      headers: { Origin: ALLOWED },
      signal: sseController.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body?.getReader();
    if (!reader) throw new Error('no body');

    gw.reconfigure({ allowedOrigins: [next] });

    // 已有 WS 连接仍可请求（鉴权状态未被重载）。
    const health = (await client.request('health.get')) as { status: string };
    expect(health.status).toBe('ok');

    // 已有 SSE 连接仍活跃：重载后发布的事件仍能收到。
    events.publish({ type: 'demo.after-reload', run_id: 'r1', data: {}, ts: Date.now() });
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('demo.after-reload')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('demo.after-reload');
    await reader.cancel();
    sseController.abort();
    client.close();

    // 新连接必须使用新 allowlist。
    expect(await wsAttempt(wsUrl, ALLOWED)).toBe('error');
    expect(await wsAttempt(wsUrl, next)).toBe('open');
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

  it('uses the reconfigured allowlist for CSP on subsequent requests', async () => {
    const gw = track(
      gateways,
      createGateway({ events: new MemoryEventStream(), staticDir, allowedOrigins: [ALLOWED] }),
    );
    const next = 'https://next.example.com';

    gw.reconfigure({ allowedOrigins: [next] });

    const res = await fetch(`${gw.url}/`, { headers: { Origin: next } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(next);
    expect(csp).not.toContain(ALLOWED);
  });
});
