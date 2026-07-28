import { describe, expect, it } from 'bun:test';
import { HookType, MemoryPluginHost } from '@vessel/core';
import mcpClientPlugin from '../src/index';

describe('mcp-client 插件（P2）', () => {
  it('install 注册 MCP 管理工具 + BeforeLlm hook', () => {
    const host = new MemoryPluginHost();
    mcpClientPlugin.install(host);
    const toolNames = host.listTools().map((t) => t.name);
    expect(toolNames).toContain('mcp_connect');
    expect(toolNames).toContain('mcp_disconnect');
    expect(toolNames).toContain('mcp_list');
    expect(host.getHooks().some((h) => h.type === HookType.BeforeLlm)).toBe(true);
  });

  it('无服务器配置时也能干净加载', () => {
    const host = new MemoryPluginHost();
    expect(() => mcpClientPlugin.install(host)).not.toThrow();
  });
});
