/**
 * 插件级行为：多 server 隔离、生命周期、控制面、命名冲突。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream, MemoryPluginHost, type ToolContext } from '@vessel-agent/core';
import { createMcpPlugin } from '../src/plugin';
import { McpPluginError, type McpServerConfig } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-server.ts', import.meta.url));

/** 捕获结构化 stderr 告警 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

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

  it('dispose closes plugin-owned connections and is idempotent (0.9)', async () => {
    const plugin = createMcpPlugin({ servers: [stdioServer()] });
    const host = new MemoryPluginHost();
    await plugin.install(host);
    expect(plugin.getServer('mock')?.status).toBe('connected');

    expect(typeof plugin.dispose).toBe('function');
    await plugin.dispose?.();
    await plugin.dispose?.();

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

  it('replaces hyphens in the server name when exposing tools', async () => {
    const plugin = createMcpPlugin({ servers: [stdioServer({ name: 'mock-srv_v2' })] });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      expect(host.getTool('mcp__mock_srv_v2__echo')).toBeDefined();
      expect(host.getTool('mcp__mock-srv_v2__echo')).toBeUndefined();
    } finally {
      await plugin.close();
    }
  });

  it('resources/prompts 能力：列出资源并读取，辅助工具默认 ask', async () => {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ env: { MOCK_RESOURCES: '1' } })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);

      expect(toolNames(host)).toEqual([
        'mcp__mock__add',
        'mcp__mock__echo',
        'mcp__mock__fail',
        'mcp__mock__list_prompts',
        'mcp__mock__list_resources',
        'mcp__mock__read_resource',
        'mcp__mock__slow',
      ]);
      expect(plugin.getServer('mock')).toMatchObject({ resources: 2, prompts: 1 });
      expect((await plugin.listResources('mock')).map((resource) => resource.uri)).toEqual([
        'mem://alpha',
        'mem://beta',
      ]);
      expect((await plugin.listPrompts('mock'))[0]?.name).toBe('greet');

      const readTool = host.getTool('mcp__mock__read_resource');
      if (!readTool) throw new Error('read_resource not registered');
      expect(await readTool.checkPermission?.({ uri: 'mem://alpha' }, makeContext())).toBe('ask');
      expect(await readTool.handler({ uri: 'mem://alpha' }, makeContext())).toBe(
        'resource-body:mem://alpha',
      );
      expect(await plugin.readResource('mock', 'mem://beta')).toBe('resource-body:mem://beta');

      const listTool = host.getTool('mcp__mock__list_resources');
      const listed = JSON.parse(String(await listTool?.handler({}, makeContext()))) as Array<{
        uri: string;
      }>;
      expect(listed).toHaveLength(2);
    } finally {
      await plugin.close();
    }
  });

  it('未连接或未知 server 的控制面调用返回稳定错误码', async () => {
    const plugin = createMcpPlugin({ servers: [stdioServer({ name: 'off', enabled: false })] });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      await expect(plugin.listResources('off')).rejects.toMatchObject({
        code: 'mcp_server_disabled',
      });
      await expect(plugin.readResource('missing', 'mem://a')).rejects.toMatchObject({
        code: 'mcp_server_not_found',
      });
    } finally {
      await plugin.close();
    }
  });

  it('warns and keeps the existing tool on a prefixed collision', async () => {
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'mcp__mock__echo',
      description: 'pre-existing tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'original',
    });
    const events = new MemoryEventStream();
    const capture = captureStderr();
    const plugin = createMcpPlugin({ servers: [stdioServer()], events });
    try {
      await plugin.install(host);

      const warnings = capture.lines
        .filter((line) => line.includes('mcp__mock__echo'))
        .map(
          (line) =>
            JSON.parse(line) as {
              level: string;
              message: string;
              fields: Record<string, unknown>;
            },
        );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: 'warn',
        fields: { server: 'mock', tool: 'mcp__mock__echo' },
      });
      expect(warnings[0]?.message).toContain('existing tool is kept');

      const event = events
        .getHistory()
        .find(
          (item) =>
            item.type === 'mcp.warning' &&
            (item.data as { tool?: string }).tool === 'mcp__mock__echo',
        );
      expect(event?.data).toMatchObject({ server: 'mock', tool: 'mcp__mock__echo' });

      expect(await host.getTool('mcp__mock__echo')?.handler({}, makeContext())).toBe('original');
      expect(host.getTool('mcp__mock__add')).toBeDefined();
    } finally {
      capture.restore();
      await plugin.close();
    }
  });

  it('告警写 stderr / mcp.warning 事件时不含 URL 凭据与密钥', async () => {
    const events = new MemoryEventStream();
    const capture = captureStderr();
    const plugin = createMcpPlugin({
      servers: [
        {
          name: 'sk-abcdefghijklmnop',
          transport: 'http',
          // 无效端口让 URL 解析失败，错误正文会回显完整 URL
          url: 'http://user:pass@example.com:99999/mcp?token=supersecret',
        },
      ],
      events,
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const text = capture.lines.join('\n');
      expect(text).toContain('MCP server configuration is invalid');
      expect(text).not.toContain('abcdefghijklmnop');
      expect(text).not.toContain('pass@');
      expect(text).not.toContain('supersecret');

      const warning = events.getHistory().find((event) => event.type === 'mcp.warning');
      expect(warning).toBeDefined();
      const serialized = JSON.stringify(warning?.data);
      expect(serialized).not.toContain('abcdefghijklmnop');
      expect(serialized).not.toContain('pass@');
      expect(serialized).not.toContain('supersecret');
    } finally {
      capture.restore();
      await plugin.close();
    }
  });
});
