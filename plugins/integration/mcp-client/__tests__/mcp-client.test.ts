import { beforeEach, describe, expect, it } from 'bun:test';
import { HookType, MemoryPluginHost } from '@vessel/core';
import mcpClientPlugin, { McpClientManager } from '../src/index';

describe('mcp-client 插件（P2）', () => {
  let host: MemoryPluginHost;

  beforeEach(() => {
    host = new MemoryPluginHost();
    mcpClientPlugin.install(host);
  });

  it('install 注册 MCP 管理工具 + BeforeLlm hook', () => {
    const toolNames = host.listTools().map((t) => t.name);
    expect(toolNames).toContain('mcp_connect');
    expect(toolNames).toContain('mcp_disconnect');
    expect(toolNames).toContain('mcp_list');
    expect(host.getHooks().some((h) => h.type === HookType.BeforeLlm)).toBe(true);
  });

  it('无服务器配置时也能干净加载', () => {
    const emptyHost = new MemoryPluginHost();
    expect(() => mcpClientPlugin.install(emptyHost)).not.toThrow();
  });

  it('mcp_list 工具在没有连接时返回提示信息', async () => {
    const mcpListTool = host.listTools().find((t) => t.name === 'mcp_list');
    expect(mcpListTool).toBeDefined();
    const result = await mcpListTool?.handler({}, { run_id: 'r1', messages: [] });
    expect(result).toContain('没有已连接的 MCP 服务器');
  });

  it('mcp_disconnect 工具在没有连接时正常执行', async () => {
    const mcpDisconnectTool = host.listTools().find((t) => t.name === 'mcp_disconnect');
    expect(mcpDisconnectTool).toBeDefined();
    const result = await mcpDisconnectTool?.handler(
      { name: 'nonexistent' },
      { run_id: 'r1', messages: [] },
    );
    expect(result).toContain('已断开 MCP 服务器');
  });

  it('mcp_connect 工具在缺少参数时返回错误', async () => {
    const mcpConnectTool = host.listTools().find((t) => t.name === 'mcp_connect');
    expect(mcpConnectTool).toBeDefined();
    // 测试缺少必需参数
    const result = await mcpConnectTool?.handler({}, { run_id: 'r1', messages: [] });
    expect(result).toContain('连接失败');
  });

  it('install 暴露 __mcpManager 到 host', () => {
    const manager = (host as unknown as Record<string, unknown>).__mcpManager;
    expect(manager).toBeDefined();
    expect(manager).toBeInstanceOf(McpClientManager);
  });

  it('工具定义包含正确的 inputSchema', () => {
    const mcpConnectTool = host.listTools().find((t) => t.name === 'mcp_connect');
    expect(mcpConnectTool).toBeDefined();
    expect(mcpConnectTool?.inputSchema).toBeDefined();
    expect(mcpConnectTool?.inputSchema.properties).toBeDefined();
    expect(mcpConnectTool?.inputSchema.required).toContain('name');
    expect(mcpConnectTool?.inputSchema.required).toContain('command');
  });

  it('mcp_connect 工具处理无效命令', async () => {
    const mcpConnectTool = host.listTools().find((t) => t.name === 'mcp_connect');
    expect(mcpConnectTool).toBeDefined();
    const result = await mcpConnectTool?.handler(
      {
        name: 'test-server',
        command: 'nonexistent-command-that-should-fail',
      },
      { run_id: 'r1', messages: [] },
    );
    expect(result).toContain('连接失败');
  });
});
