/**
 * Streamable HTTP 传输层测试（直接驱动 HttpTransport，本地 Bun.serve fixture）。
 */

import { describe, expect, it } from 'bun:test';
import { HttpTransport } from '../src/http-transport';
import type { McpServerConfig } from '../src/types';
import { startMockHttpServer } from './fixtures/mock-http-server';

function config(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'mock', transport: 'http', url, ...overrides };
}

async function initialize(transport: HttpTransport): Promise<unknown> {
  return transport.request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
    { timeoutMs: 2000 },
  );
}

async function captureError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function methodOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const method = (body as Record<string, unknown>).method;
  return typeof method === 'string' ? method : undefined;
}

describe('HttpTransport', () => {
  it('handshakes and calls tools with JSON responses', async () => {
    const server = startMockHttpServer();
    const transport = new HttpTransport(config(server.url));
    try {
      await transport.start();
      const init = (await initialize(transport)) as { protocolVersion: string };
      expect(init.protocolVersion).toBe('2025-06-18');

      await transport.notify('notifications/initialized');
      const list = (await transport.request('tools/list', {}, { timeoutMs: 2000 })) as {
        tools: Array<{ name: string }>;
      };
      expect(list.tools).toHaveLength(4);

      const result = (await transport.request(
        'tools/call',
        { name: 'add', arguments: { a: 2, b: 3 } },
        { timeoutMs: 2000 },
      )) as { content: Array<{ text: string }> };
      expect(result.content[0]?.text).toBe('5');
    } finally {
      await transport.close();
      server.close();
    }
  });

  it('parses SSE responses', async () => {
    const server = startMockHttpServer({ mode: 'sse' });
    const transport = new HttpTransport(config(server.url));
    try {
      await transport.start();
      const init = (await initialize(transport)) as { serverInfo: { name: string } };
      expect(init.serverInfo.name).toBe('mock-http');
      const result = (await transport.request(
        'tools/call',
        { name: 'echo', arguments: { ok: true } },
        { timeoutMs: 2000 },
      )) as { content: Array<{ text: string }> };
      expect(result.content[0]?.text).toBe('{"ok":true}');
    } finally {
      await transport.close();
      server.close();
    }
  });

  it('sends session and protocol headers on subsequent requests', async () => {
    const server = startMockHttpServer({ requireSession: true });
    const transport = new HttpTransport(config(server.url));
    try {
      await transport.start();
      await initialize(transport);
      await transport.request('tools/list', {}, { timeoutMs: 2000 });

      const initializeRequest = server.requests.find(
        (request) => methodOf(request.body) === 'initialize',
      );
      expect(initializeRequest?.headers.accept).toBe('application/json, text/event-stream');
      expect(initializeRequest?.headers['mcp-session-id']).toBeUndefined();

      const list = server.requests.find((request) => methodOf(request.body) === 'tools/list');
      expect(list?.headers['mcp-session-id']).toBeDefined();
      expect(list?.headers['mcp-protocol-version']).toBe('2025-06-18');
    } finally {
      await transport.close();
      server.close();
    }
  });

  it('closes and reports when the session expires (404)', async () => {
    const server = startMockHttpServer({ expireAfterRequests: 1 });
    const transport = new HttpTransport(config(server.url));
    try {
      const closed = new Promise<string>((resolve) => transport.onClose(resolve));
      await transport.start();
      await initialize(transport);
      const message = await captureError(transport.request('tools/list', {}, { timeoutMs: 2000 }));
      expect(message).toContain('session expired');
      expect(await closed).toContain('session expired');
    } finally {
      await transport.close();
      server.close();
    }
  });

  it('reports network failures through onClose', async () => {
    const transport = new HttpTransport(
      config('http://127.0.0.1:1/mcp', { connectTimeoutMs: 1000 }),
    );
    try {
      const closed = new Promise<string>((resolve) => transport.onClose(resolve));
      await transport.start();
      const message = await captureError(initialize(transport));
      expect(message).toContain('HTTP request failed');
      expect(await closed).toContain('HTTP request failed');
    } finally {
      await transport.close();
    }
  });
});
