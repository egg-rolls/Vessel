/**
 * tenant 工具策略的 PluginHost 包装器（0.18，DECISION-032 §1）。
 *
 * 故障形态：过滤只发生在策略函数、没有落到注册边界；或包装器吞掉
 * `beginPluginInstall`，安装失败时留下半装工具。
 */

import { describe, expect, it } from 'bun:test';
import { MemoryPluginHost, type ToolDefinition } from '../../packages/core/src/index';
import { TenantToolHost } from '../tenant-runtime-factory';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => name,
  };
}

function toolNames(host: { listTools(): ToolDefinition[] }): string[] {
  return host.listTools().map((def) => def.name);
}

describe('TenantToolHost', () => {
  it('empty allow registers no tools on the filtered host', () => {
    const host = new TenantToolHost(new MemoryPluginHost(), { allow: [] });
    host.registerTool(tool('bash'));
    host.registerTool(tool('read'));
    expect(toolNames(host)).toEqual([]);
    expect(host.getTool('bash')).toBeUndefined();
  });

  it('filtered host rollback removes tools registered during a failed install', () => {
    const inner = new MemoryPluginHost();
    const host = new TenantToolHost(inner, { deny: ['denied'] });
    const scope = host.beginPluginInstall?.('probe');
    // 包装器必须在内部 host 支持回滚时转发，否则安装失败会留下半装工具。
    expect(scope).toBeDefined();

    host.registerTool(tool('allowed'));
    host.registerTool(tool('denied'));
    expect(toolNames(host)).toEqual(['allowed']);

    scope?.rollback();
    expect(toolNames(host)).toEqual([]);
    expect(inner.getTool('allowed')).toBeUndefined();
  });
});
