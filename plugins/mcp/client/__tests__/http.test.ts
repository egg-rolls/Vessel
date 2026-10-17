/**
 * Streamable HTTP 传输测试（本地 Bun.serve fixture，不联网）。
 */

import { describe, expect, it } from 'bun:test';
import {
  MemoryEventStream,
  MemoryPluginHost,
  type ToolContext,
  type ToolDefinition,
} from '@vessel/core';
import { createMcpPlugin } from '../src/plugin';
import type { McpServerConfig } from '../src/types';
import { type MockHttpServer, startMockHttpServer } from './fixtures/mock-http-server';

function httpServer(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'mock', transport: 'http', url, ...overrides };
}

function makeContext(): ToolContext {
  return { run_id: 'http-test', messages: [], events: new MemoryEventStream() };
}

function toolOf(host: MemoryPluginHost, name: string): ToolDefinition {
  const tool = host.getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

function methodOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const method = (body as Record<string, unknown>).method;
  return typeof method === 'string' ? method : undefined;
}

async function withServer<T>(
  options: Parameters<typeof startMockHttpServer>[0],
  fn: (server: MockHttpServer) => Promise<T>,
): Promise<T> {
  const server = startMockHttpServer(options);
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

describe('MCP Streamable HTTP transport', () => {
  it('connects and calls tools with JSON responses', async () => {
    await withServer({}, async (server) => {
      const plugin = createMcpPlugin({ servers: [httpServer(server.url)] });
      const host = new MemoryPluginHost();
      try {
        await plugin.install(host);
        expect(plugin.getServer('mock')?.status).toBe('connected');
        expect(await toolOf(host, 'mcp__mock__echo').handler({ a: 1 }, makeContext())).toBe(
          '{"a":1}',
        );
        expect(await toolOf(host, 'mcp__mock__add').handler({ a: 2, b: 5 }, makeContext())).toBe(
          '7',
        );
      } finally {
        await plugin.close();
      }
    });
  });

  it('parses SSE responses with interleaved notifications', async () => {
    await withServer({ mode: 'sse' }, async (server) => {
      const plugin = createMcpPlugin({ servers: [httpServer(server.url)] });
      const host = new MemoryPluginHost();
      try {
        await plugin.install(host);
        expect(plugin.getServer('mock')?.status).toBe('connected');
        expect(await toolOf(host, 'mcp__mock__echo').handler({ ok: true }, makeContext())).toBe(
          '{"ok":true}',
        );
      } finally {
        await plugin.close();
      }
    });
  });

  it('sends protocol and session headers on subsequent requests', async () => {
    await withServer({ requireSession: true }, async (server) => {
      const plugin = createMcpPlugin({ servers: [httpServer(server.url)] });
      const host = new MemoryPluginHost();
      try {
        await plugin.install(host);
        const initialize = server.requests.find(
          (request) => methodOf(request.body) === 'initialize',
        );
        expect(initialize?.headers.accept).toBe('application/json, text/event-stream');
        expect(initialize?.headers['mcp-session-id']).toBeUndefined();

        const list = server.requests.find((request) => methodOf(request.body) === 'tools/list');
        expect(list?.headers['mcp-session-id']).toBeDefined();
        expect(list?.headers['mcp-protocol-version']).toBe('2025-06-18');
      } finally {
        await plugin.close();
      }
    });
  });

  it('marks the server failed when the session expires (404)', async () => {
    await withServer({ expireAfterRequests: 3 }, async (server) => {
      const events = new MemoryEventStream();
      const plugin = createMcpPlugin({ servers: [httpServer(server.url)], events });
      const host = new MemoryPluginHost();
      try {
        await plugin.install(host);
        expect(plugin.getServer('mock')?.status).toBe('connected');
        await expect(toolOf(host, 'mcp__mock__echo').handler({}, makeContext())).rejects.toThrow(
          /session expired/,
        );
        expect(plugin.getServer('mock')?.status).toBe('failed');
        expect(events.getHistory().some((event) => event.type === 'mcp.server.disconnected')).toBe(
          true,
        );
      } finally {
        await plugin.close();
      }
    });
  });

  it('isolates connection failures without throwing', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({
      servers: [
        httpServer('http://127.0.0.1:1/mcp', {
          name: 'offline',
          connectTimeoutMs: 1000,
        }),
      ],
      events,
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(plugin.getServer('offline')?.status).toBe('failed');
      expect(plugin.getServer('offline')?.error).toBeDefined();
      expect(events.getHistory().some((event) => event.type === 'mcp.server.failed')).toBe(true);
      expect(host.listTools()).toHaveLength(0);
    } finally {
      await plugin.close();
    }
  });
});
