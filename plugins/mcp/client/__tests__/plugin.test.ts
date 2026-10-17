/**
 * 插件级行为：多 server 隔离、生命周期、控制面、命名冲突。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream, MemoryPluginHost, type ToolContext } from '@vessel/core';
import { createMcpPlugin } from '../src/plugin';
import { McpPluginError, type McpServerConfig } from '../src/types';

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

function makeContext(): ToolContext {
  return { run_id: 'plugin-test', messages: [], events: new MemoryEventStream() };
}

function toolNames(host: MemoryPluginHost): string[] {
  return host
    .listTools()
    .map((tool) => tool.name)
    .sort();
}

describe('createMcpPlugin', () => {
  it('isolates one failing server and keeps the healthy one', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({
      servers: [
        { name: 'broken', transport: 'stdio', command: 'vessel-command-that-does-not-exist' },
        stdioServer({ name: 'healthy' }),
      ],
      events,
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(plugin.getServer('broken')?.status).toBe('failed');
      expect(plugin.getServer('healthy')?.status).toBe('connected');
      expect(toolNames(host)).toEqual([
        'mcp__healthy__add',
        'mcp__healthy__echo',
        'mcp__healthy__fail',
        'mcp__healthy__slow',
      ]);
      const history = events.getHistory();
      expect(history.some((event) => event.type === 'mcp.server.failed')).toBe(true);
      expect(history.some((event) => event.type === 'mcp.server.connected')).toBe(true);
    } finally {
      await plugin.close();
    }
  });

  it('reports disabled servers in listServers and does not connect them', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ name: 'off', enabled: false })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(host.listTools()).toHaveLength(0);
      expect(plugin.listServers()).toHaveLength(1);
      expect(plugin.getServer('off')).toMatchObject({ name: 'off', status: 'disabled', tools: [] });
      await expect(plugin.reconnect('off')).rejects.toMatchObject({
        code: 'mcp_server_disabled',
      });
    } finally {
      await plugin.close();
    }
  });

  it('returns stable codes for unknown and disabled servers', async () => {
    const plugin = createMcpPlugin({ servers: [stdioServer({ name: 'off', enabled: false })] });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      await expect(plugin.reconnect('missing')).rejects.toBeInstanceOf(McpPluginError);
      await expect(plugin.reconnect('missing')).rejects.toMatchObject({
        code: 'mcp_server_not_found',
      });
      await expect(plugin.reconnect('off')).rejects.toMatchObject({
        code: 'mcp_server_disabled',
      });
    } finally {
      await plugin.close();
    }
  });

  it('is idempotent on install and close', async () => {
    const plugin = createMcpPlugin({ servers: [stdioServer()] });
    const host = new MemoryPluginHost();
    await plugin.install(host);
    await plugin.install(host);
    expect(toolNames(host)).toHaveLength(4);

    await plugin.close();
    await plugin.close();
    await expect(host.getTool('mcp__mock__echo')?.handler({}, makeContext())).rejects.toThrow(
      /not connected/,
    );
  });

  it('reconnects a server and keeps tools callable', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({ servers: [stdioServer()], events });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      await plugin.reconnect('mock');
      expect(plugin.getServer('mock')?.status).toBe('connected');
      expect(toolNames(host)).toHaveLength(4);
      expect(await host.getTool('mcp__mock__echo')?.handler({ x: 1 }, makeContext())).toBe(
        '{"x":1}',
      );
      expect(
        events.getHistory().filter((event) => event.type === 'mcp.server.connected'),
      ).toHaveLength(2);
    } finally {
      await plugin.close();
    }
  });

  it('rejects an invalid server config without failing install', async () => {
    const events = new MemoryEventStream();
    const plugin = createMcpPlugin({
      servers: [{ name: 'invalid', transport: 'stdio' }],
      events,
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const status = plugin.getServer('invalid');
      expect(status?.status).toBe('failed');
      expect(status?.error).toContain('command');
      expect(host.listTools()).toHaveLength(0);
      expect(events.getHistory().some((event) => event.type === 'mcp.server.failed')).toBe(true);
    } finally {
      await plugin.close();
    }
  });

  it('marks duplicate server names as failed and keeps the first', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer(), stdioServer()],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const statuses = plugin.listServers();
      expect(statuses).toHaveLength(2);
      expect(statuses[0]?.status).toBe('connected');
      expect(statuses[1]?.status).toBe('failed');
      expect(statuses[1]?.error).toContain('duplicate server name');
      expect(toolNames(host)).toHaveLength(4);
    } finally {
      await plugin.close();
    }
  });

  it('skips colliding names when toolPrefix is false', async () => {
    const plugin = createMcpPlugin({
      servers: [
        stdioServer({ name: 'one', toolPrefix: false }),
        stdioServer({ name: 'two', toolPrefix: false }),
      ],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(toolNames(host)).toEqual(['add', 'echo', 'fail', 'slow']);
      expect(plugin.getServer('one')?.tools).toHaveLength(4);
      expect(plugin.getServer('two')?.tools).toHaveLength(0);
    } finally {
      await plugin.close();
    }
  });
});
