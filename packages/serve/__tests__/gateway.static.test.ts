import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

describe('gateway static hosting', () => {
  let staticDir: string;
  let gw: Gateway;

  beforeAll(async () => {
    staticDir = await mkdtemp(join(tmpdir(), 'vessel-gw-static-'));
    await mkdir(join(staticDir, 'assets'), { recursive: true });
    await writeFile(
      join(staticDir, 'index.html'),
      '<!doctype html><html><body><div id="root">vessel</div></body></html>',
      'utf8',
    );
    await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("vessel");', 'utf8');
    await writeFile(join(staticDir, 'secret.txt'), 'top-secret', 'utf8');
    gw = createGateway({ events: new MemoryEventStream(), staticDir });
  });

  afterAll(async () => {
    gw.stop();
    await rm(staticDir, { recursive: true, force: true });
  });

  it('serves index.html at the root with CSP', async () => {
    const res = await fetch(`${gw.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('id="root"');
  });

  it('serves assets with correct content type', async () => {
    const res = await fetch(`${gw.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('console.log');
  });

  it('falls back to index.html for SPA routes', async () => {
    const res = await fetch(`${gw.url}/sessions/123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('does not fall back for missing assets', async () => {
    const res = await fetch(`${gw.url}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it('rejects path traversal', async () => {
    // 注意：`/../` 会被 URL 规范化掉；用编码斜杠确保路径到达解析器。
    const res = await fetch(`${gw.url}/%2e%2e%2f%2e%2e%2fsecret.txt`);
    expect([403, 404]).toContain(res.status);
  });

  it('keeps API paths out of the SPA fallback', async () => {
    const res = await fetch(`${gw.url}/v1/unknown`);
    expect(res.status).toBe(401);
    const authed = await fetch(`${gw.url}/v1/unknown`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(authed.status).toBe(404);
    const body = (await authed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('does not serve static content for POST', async () => {
    const res = await fetch(`${gw.url}/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(res.status).toBe(404);
  });
});
