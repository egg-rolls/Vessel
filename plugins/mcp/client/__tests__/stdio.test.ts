/**
 * stdio 传输端到端测试（本地 fixture 子进程，不联网）。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  MemoryEventStream,
  MemoryPluginHost,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';
import { createMcpPlugin } from '../src/plugin';
import type { McpServerConfig } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-server.ts', import.meta.url));

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'mock',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    ...overrides,
  };
}

function makeContext(signal?: AbortSignal): ToolContext {
  return {
    run_id: 'stdio-test',
    messages: [],
    events: new MemoryEventStream(),
    ...(signal !== undefined ? { signal } : {}),
  };
}

function toolOf(host: MemoryPluginHost, name: string): ToolDefinition {
  const tool = host.getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('MCP stdio transport', () => {
  it('connects, lists tools, calls tools and emits events', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({ servers: [stdioServer()], events });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const status = plugin.getServer('mock');
      expect(status?.status).toBe('connected');
      expect(status?.protocolVersion).toBe('2025-06-18');
      expect(status?.tools.sort()).toEqual([
        'mcp__mock__add',
        'mcp__mock__echo',
        'mcp__mock__fail',
        'mcp__mock__slow',
      ]);

      expect(await toolOf(host, 'mcp__mock__echo').handler({ text: 'hi' }, makeContext())).toBe(
        '{"text":"hi"}',
      );
      expect(await toolOf(host, 'mcp__mock__add').handler({ a: 1, b: 2 }, makeContext())).toBe('3');

      const history = events.getHistory();
      expect(history.some((event) => event.type === 'mcp.server.connected')).toBe(true);
      const called = history.find((event) => event.type === 'mcp.tool.called');
      expect(called?.data).toMatchObject({ server: 'mock', tool: 'echo' });
      expect(called?.run_id).toBe('stdio-test');
    } finally {
      await plugin.close();
    }
  });

  it('returns isError text and emits mcp.tool.failed', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({ servers: [stdioServer()], events });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const text = await toolOf(host, 'mcp__mock__fail').handler({}, makeContext());
      expect(text).toBe('boom');
      const failed = events.getHistory().find((event) => event.type === 'mcp.tool.failed');
      expect(failed?.data).toMatchObject({ server: 'mock', tool: 'fail', isError: true });
    } finally {
      await plugin.close();
    }
  });

  it('enforces toolTimeoutMs', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ env: { MOCK_SLOW_MS: '2000' }, toolTimeoutMs: 100 })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      await expect(toolOf(host, 'mcp__mock__slow').handler({}, makeContext())).rejects.toThrow(
        /timed out after 100ms/,
      );
    } finally {
      await plugin.close();
    }
  });

  it('aborts an in-flight call when ctx.signal aborts', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ env: { MOCK_SLOW_MS: '2000' }, toolTimeoutMs: 5000 })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const controller = new AbortController();
      const call = toolOf(host, 'mcp__mock__slow').handler({}, makeContext(controller.signal));
      setTimeout(() => controller.abort(), 50);
      await expect(call).rejects.toThrow(/aborted/);
    } finally {
      await plugin.close();
    }
  });

  it('handles paginated tools/list', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ env: { MOCK_PAGINATE: '1' } })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(plugin.getServer('mock')?.tools).toHaveLength(4);
      expect(host.getTool('mcp__mock__slow')).toBeDefined();
    } finally {
      await plugin.close();
    }
  });

  it('marks the server failed and rejects calls after the process exits', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({
      servers: [stdioServer({ env: { MOCK_DIE_AFTER_INIT: '1' } })],
      events,
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      await waitFor(() =>
        events.getHistory().some((event) => event.type === 'mcp.server.disconnected')
          ? true
          : undefined,
      );
      expect(plugin.getServer('mock')?.status).toBe('failed');
      await expect(toolOf(host, 'mcp__mock__echo').handler({}, makeContext())).rejects.toThrow(
        /not connected/,
      );
    } finally {
      await plugin.close();
    }
  });
});
