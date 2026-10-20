import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import type { EventStream, PluginHost } from '../../packages/core/src/index';
import {
  createMcpControl,
  createMcpFromConfig,
  installMcp,
  type McpModuleLike,
  type McpPluginLike,
  McpPluginUnavailableError,
  type McpServerSummary,
  resolveMcpServers,
} from '../mcp-wiring';

const events = {} as EventStream;

function pluginWith(overrides: Partial<McpPluginLike> = {}): McpPluginLike {
  return {
    name: 'mcp-client',
    install: () => {},
    close: async () => {},
    ...overrides,
  } as McpPluginLike;
}

function moduleWith(plugin: McpPluginLike): McpModuleLike {
  return {
    createMcpPlugin: () => plugin,
  };
}

describe('resolveMcpServers', () => {
  it('按 server 名排序并补入 name；enabled:false 也保留', () => {
    const config: VesselConfig = {
      mcpServers: {
        zeta: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
        alpha: { transport: 'stdio', command: 'node', enabled: false },
      },
    };
    expect(resolveMcpServers(config).map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('未配置时返回空数组', () => {
    expect(resolveMcpServers({})).toEqual([]);
  });
});

describe('createMcpFromConfig', () => {
  it('未配置 mcp_servers：返回 null 且不加载模块', async () => {
    let loaded = 0;
    const result = await createMcpFromConfig({
      config: {},
      events,
      loadModule: async () => {
        loaded++;
        return moduleWith(pluginWith());
      },
    });
    expect(result).toBeNull();
    expect(loaded).toBe(0);
  });

  it('把配置（含默认 enabled）映射给工厂，并返回控制面', async () => {
    let received: unknown;
    const plugin = pluginWith();
    const mod: McpModuleLike = {
      createMcpPlugin: (options) => {
        received = options;
        return plugin;
      },
    };
    const config: VesselConfig = {
      mcpServers: {
        demo: {
          transport: 'stdio',
          command: 'node',
          args: ['x.js'],
          connectTimeoutMs: 500,
          autoApproveTools: ['echo'],
        },
      },
    };

    const result = await createMcpFromConfig({
      config,
      events,
      loadModule: async () => mod,
    });

    expect(result?.plugin).toBe(plugin);
    expect(received).toEqual({
      servers: [
        {
          name: 'demo',
          transport: 'stdio',
          command: 'node',
          args: ['x.js'],
          connectTimeoutMs: 500,
          autoApproveTools: ['echo'],
        },
      ],
      events,
    });
  });

  it('passes tenantId to the factory', async () => {
    let received: unknown;
    const plugin = pluginWith();
    const mod: McpModuleLike = {
      createMcpPlugin: (options) => {
        received = options;
        return plugin;
      },
    };

    await createMcpFromConfig({
      config: { mcpServers: { demo: { transport: 'stdio', command: 'node' } } },
      events,
      tenantId: 'acme',
      loadModule: async () => mod,
    });

    expect(received).toMatchObject({ tenantId: 'acme' });
  });

  it('模块缺失或无 createMcpPlugin：抛 mcp_plugin_unavailable', async () => {
    const config: VesselConfig = {
      mcpServers: { demo: { transport: 'stdio', command: 'node' } },
    };

    await expect(
      createMcpFromConfig({ config, events, loadModule: async () => null }),
    ).rejects.toBeInstanceOf(McpPluginUnavailableError);

    await expect(
      createMcpFromConfig({ config, events, loadModule: async () => ({}) }),
    ).rejects.toMatchObject({ code: 'mcp_plugin_unavailable' });
  });

  it('installMcp 调用 plugin.install 并透传 PluginHost', async () => {
    const installed: PluginHost[] = [];
    const host = {} as PluginHost;
    const plugin = pluginWith({
      install: (received) => {
        installed.push(received);
      },
    });

    const result = await installMcp(
      {
        config: { mcpServers: { demo: { transport: 'stdio', command: 'node' } } },
        events,
        loadModule: async () => moduleWith(plugin),
      },
      host,
    );

    expect(result?.plugin).toBe(plugin);
    expect(installed).toEqual([host]);
  });
});

describe('createMcpControl', () => {
  const servers = resolveMcpServers({
    mcpServers: {
      demo: { transport: 'stdio', command: 'node' },
      off: { transport: 'stdio', command: 'node', enabled: false },
      raw: { transport: 'stdio', command: 'node', toolPrefix: false },
    },
  });

  it('list 直接返回插件快照', async () => {
    const snapshot: McpServerSummary[] = [
      { name: 'demo', status: 'connected', tools: ['mcp__demo__echo'] },
    ];
    const control = createMcpControl(pluginWith({ listServers: () => snapshot }), servers);
    expect(await control.list()).toBe(snapshot);
  });

  it('无 listServers 时回退：disabled 保留，其余 failed 且不猜工具', async () => {
    const control = createMcpControl(pluginWith(), servers);
    const list = await control.list();
    expect(list.find((s) => s.name === 'off')?.status).toBe('disabled');
    expect(list.find((s) => s.name === 'demo')).toMatchObject({ status: 'failed', tools: [] });
  });

  it('reconnect：未知/disabled 抛稳定 code；成功返回最新状态', async () => {
    const calls: string[] = [];
    const plugin = pluginWith({
      reconnect: async (name: string) => {
        calls.push(name);
      },
      getServer: (name: string) => ({ name, status: 'connected', tools: ['t'] }),
    });
    const control = createMcpControl(plugin, servers);

    await expect(control.reconnect('nope')).rejects.toMatchObject({
      code: 'mcp_server_not_found',
    });
    await expect(control.reconnect('off')).rejects.toMatchObject({
      code: 'mcp_server_disabled',
    });
    expect(await control.reconnect('demo')).toEqual({
      name: 'demo',
      status: 'connected',
      tools: ['t'],
    });
    expect(calls).toEqual(['demo']);
  });

  it('toolSource：解析前缀（含非法字符替换）与 toolPrefix=false 原名', () => {
    const serverList = resolveMcpServers({
      mcpServers: {
        'my-server': { transport: 'stdio', command: 'node' },
        raw: { transport: 'stdio', command: 'node', toolPrefix: false },
      },
    });
    const control = createMcpControl(pluginWith(), serverList);

    expect(control.toolSource('mcp__my_server__echo')).toEqual({
      server: 'my-server',
      tool: 'echo',
    });
    expect(control.toolSource('not_mcp')).toBeNull();
  });
});
