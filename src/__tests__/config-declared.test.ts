import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryEventStream, MemoryPluginHost } from '../../packages/core/src/index';
import { ConfigDeclared } from '../config-declared';

const toolCtx = { run_id: 'r1', messages: [], events: new MemoryEventStream() };

describe('ConfigDeclared 配置声明工具（#95）', () => {
  it('getAvailablePlugins 返回声明工具名（command/url），忽略内置工具开关', () => {
    const config: VesselConfig = {
      tools: [
        { name: 'my-weather', command: 'echo hi' },
        { name: 'my-api', url: 'http://localhost:1/x' },
        { name: 'shell', enabled: false }, // 无 command/url → 内置开关，忽略
      ],
    };
    const provider = new ConfigDeclared(config);
    expect(provider.getAvailablePlugins().sort()).toEqual(['my-api', 'my-weather']);
  });

  it('loadPlugin 构建 shell 工具并注册', async () => {
    const config: VesselConfig = {
      tools: [{ name: 'echo-tool', description: 'echo', command: 'echo hi {{name}}' }],
    };
    const provider = new ConfigDeclared(config);
    const plugin = await provider.loadPlugin('echo-tool');
    expect(plugin).not.toBeNull();
    expect(plugin?.name).toBe('echo-tool');
    const host = new MemoryPluginHost();
    await plugin?.install(host);
    const tool = host.getTool('echo-tool');
    expect(tool?.description).toBe('echo');
    expect(await tool?.handler({ name: 'world' }, toolCtx)).toBe('hi world');
  });

  it('loadPlugin 构建 http 工具（本地 server 验证占位符替换）', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`got:${new URL(req.url).searchParams.get('q')}`),
    });
    try {
      const config: VesselConfig = {
        tools: [
          {
            name: 'http-tool',
            description: 'http echo',
            url: `http://127.0.0.1:${server.port}/search?q={{q}}`,
            method: 'GET',
          },
        ],
      };
      const provider = new ConfigDeclared(config);
      const plugin = await provider.loadPlugin('http-tool');
      expect(plugin).not.toBeNull();
      const host = new MemoryPluginHost();
      await plugin?.install(host);
      const tool = host.getTool('http-tool');
      expect(tool?.description).toBe('http echo');
      expect(await tool?.handler({ q: 'abc' }, toolCtx)).toBe('got:abc');
    } finally {
      server.stop();
    }
  });

  it('未声明工具返回 null', async () => {
    const provider = new ConfigDeclared({});
    expect(provider.getAvailablePlugins()).toEqual([]);
    expect(await provider.loadPlugin('nope')).toBeNull();
  });

  it('getProviders 返回空', () => {
    const provider = new ConfigDeclared({});
    expect(provider.getProviders()).toEqual([]);
  });
});
