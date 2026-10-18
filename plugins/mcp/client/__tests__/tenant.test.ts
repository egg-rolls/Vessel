/**
 * 0.5 tenant 作用域：事件带 tenant_id、实例之间不共享状态。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import { createMcpPlugin } from '../src/plugin';
import type { McpServerConfig } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-server.ts', import.meta.url));

function stdioServer(name = 'mock'): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
  };
}

describe('MCP tenant scope', () => {
  it('stamps tenant_id on every server event', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({
      servers: [stdioServer('healthy')],
      events,
      tenantId: 'acme',
    });
    try {
      await plugin.install(new MemoryPluginHost());
      const history = events.getHistory();
      expect(history.length).toBeGreaterThan(0);
      for (const event of history) expect(event.tenant_id).toBe('acme');
    } finally {
      await plugin.close();
    }
  });

  it('keeps same-named servers isolated between tenant instances', async () => {
    const eventsA = new MemoryEventStream();
    const eventsB = new MemoryEventStream();
    const hostA = new MemoryPluginHost();
    const hostB = new MemoryPluginHost();
    const pluginA = createMcpPlugin({
      servers: [stdioServer('github')],
      events: eventsA,
      tenantId: 'tenant_a',
    });
    const pluginB = createMcpPlugin({
      servers: [stdioServer('github')],
      events: eventsB,
      tenantId: 'tenant_b',
    });
    try {
      await pluginA.install(hostA);
      await pluginB.install(hostB);
      expect(hostA.listTools().map((tool) => tool.name)).toContain('mcp__github__echo');
      expect(hostB.listTools().map((tool) => tool.name)).toContain('mcp__github__echo');
      expect(eventsA.getHistory().every((event) => event.tenant_id === 'tenant_a')).toBe(true);
      expect(eventsB.getHistory().every((event) => event.tenant_id === 'tenant_b')).toBe(true);
    } finally {
      await Promise.all([pluginA.close(), pluginB.close()]);
    }
  });

  it('keeps 0.4 envelope when tenantId is omitted', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({ servers: [stdioServer('healthy')], events });
    try {
      await plugin.install(new MemoryPluginHost());
      const history = events.getHistory();
      expect(history.length).toBeGreaterThan(0);
      for (const event of history) expect('tenant_id' in event).toBe(false);
    } finally {
      await plugin.close();
    }
  });

  it('rejects an invalid tenant id', () => {
    expect(() => createMcpPlugin({ servers: [], tenantId: 'Bad Tenant' })).toThrow(
      /invalid tenant id/,
    );
  });
});
