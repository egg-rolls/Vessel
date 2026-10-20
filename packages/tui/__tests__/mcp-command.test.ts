import { describe, expect, it } from 'bun:test';
import { formatMcpServers, runMcpCommand } from '../src/commands/mcp-command.js';
import type { McpControl, McpServerSummary } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const servers: McpServerSummary[] = [
  {
    name: 'github',
    status: 'connected',
    tools: ['mcp__github__search', 'mcp__github__create_issue'],
  },
  { name: 'fs', status: 'failed', tools: [], error: 'connect ECONNREFUSED' },
  { name: 'off', status: 'disabled', tools: [] },
];

function fakeControl(
  list: () => Promise<McpServerSummary[]> = async () => servers,
  reconnectImpl?: (name: string) => Promise<McpServerSummary>,
) {
  const calls: string[] = [];
  const control: McpControl = {
    list,
    reconnect: async (name) => {
      calls.push(name);
      if (reconnectImpl) return reconnectImpl(name);
      return (
        servers.find((server) => server.name === name) ?? { name, status: 'connected', tools: [] }
      );
    },
    toolSource: (toolName) => {
      const match = /^mcp__([^_]+)__(.+)$/.exec(toolName);
      return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : null;
    },
  };
  return { calls, control };
}

describe('formatMcpServers', () => {
  it('渲染 name / status / 工具数与错误', () => {
    const output = formatMcpServers(servers);
    expect(output).toContain('MCP servers (3)');
    expect(output).toContain('github');
    expect(output).toContain('connected');
    expect(output).toContain('2 tools');
    expect(output).toContain('fs');
    expect(output).toContain('failed');
    expect(output).toContain('connect ECONNREFUSED');
    expect(output).toContain('off');
    expect(output).toContain('disabled');
  });
});

describe('/mcp command', () => {
  it('未注入控制面 -> 明确提示，不抛错', async () => {
    const result = await runMcpCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('MCP is not enabled');
  });

  it('无参列出 server', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl().control;
    const result = await runMcpCommand([], ctx);
    expect(result.output ?? '').toContain('github');
    expect(result.output ?? '').toContain('2 tools');
  });

  it('reconnect 成功会调用控制面并刷新工具数', async () => {
    const { calls, control } = fakeControl(
      async () => servers,
      async (name) => ({
        name,
        status: 'connected',
        tools: ['mcp__github__search'],
      }),
    );
    const ctx = makeCtx();
    ctx.mcp = control;
    const result = await runMcpCommand(['reconnect', 'github'], ctx);
    expect(calls).toEqual(['github']);
    expect(result.output ?? '').toContain('Reconnected MCP server "github" (1 tools)');
  });

  it('未知 server -> 提示且不调用 reconnect', async () => {
    const { calls, control } = fakeControl();
    const ctx = makeCtx();
    ctx.mcp = control;
    const result = await runMcpCommand(['reconnect', 'nope'], ctx);
    expect(calls).toEqual([]);
    expect(result.output ?? '').toContain('No MCP server named "nope"');
  });

  it('disabled server -> 拒绝重连', async () => {
    const { calls, control } = fakeControl();
    const ctx = makeCtx();
    ctx.mcp = control;
    const result = await runMcpCommand(['reconnect', 'off'], ctx);
    expect(calls).toEqual([]);
    expect(result.output ?? '').toContain('disabled');
  });

  it('reconnect 网络错误复用 error-classifier', async () => {
    const { control } = fakeControl(
      async () => servers,
      async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1');
      },
    );
    const ctx = makeCtx();
    ctx.mcp = control;
    const result = await runMcpCommand(['reconnect', 'github'], ctx);
    expect(result.output ?? '').toContain('[network]');
  });

  it('参数校验', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl().control;
    expect((await runMcpCommand(['reconnect'], ctx)).output ?? '').toContain(
      'Usage: /mcp reconnect',
    );
    expect((await runMcpCommand(['wat'], ctx)).output ?? '').toContain('Unknown /mcp subcommand');
  });
});
