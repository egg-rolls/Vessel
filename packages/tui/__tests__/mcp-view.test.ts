import { describe, expect, it } from 'bun:test';
import {
  buildMcpDetailView,
  buildMcpListView,
  disabledMcpView,
  mcpListActions,
  mcpStatusLabel,
  runMcpCommand,
  runMcpViewAction,
} from '../src/commands/mcp-command.js';
import type { McpControl, McpServerSummary } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const SERVERS: McpServerSummary[] = [
  {
    name: 'github',
    status: 'connected',
    tools: ['mcp__github__search', 'mcp__github__create_issue'],
  },
  { name: 'fs', status: 'failed', tools: [], error: 'connect ECONNREFUSED' },
  { name: 'off', status: 'disabled', tools: [] },
];

function fakeControl(reconnectImpl?: (name: string) => Promise<McpServerSummary>): McpControl {
  return {
    list: async () => SERVERS,
    reconnect: async (name) =>
      reconnectImpl?.(name) ??
      SERVERS.find((server) => server.name === name) ?? {
        name,
        status: 'connected',
        tools: [],
      },
    toolSource: (toolName) => {
      const match = /^mcp__([^_]+)__(.+)$/.exec(toolName);
      return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : null;
    },
  };
}

describe('/mcp view mapping', () => {
  it('列表项带状态 glyph、工具数与 error；动作为 enter/r/g', () => {
    const view = buildMcpListView(SERVERS);
    expect(view.kind).toBe('list');
    expect(view.items.map((item) => item.key)).toEqual(['github', 'fs', 'off']);
    expect(view.items[0]?.label).toBe('github');
    expect(view.items[0]?.description).toContain('2 tools');
    expect(view.items[1]?.description).toContain('ECONNREFUSED');
    expect(view.items[1]?.tone).toBe('danger');
    expect(mcpListActions().map((action) => action.key)).toEqual(['enter', 'r', 'g']);
  });

  it('状态标签同时有 glyph 与文本', () => {
    expect(mcpStatusLabel(SERVERS[0] as McpServerSummary)).toBe('● connected');
    expect(mcpStatusLabel(SERVERS[1] as McpServerSummary)).toBe('✗ failed');
    expect(mcpStatusLabel(SERVERS[2] as McpServerSummary)).toBe('○ disabled');
  });

  it('详情列出工具名并带 key；无工具给占位', () => {
    const view = buildMcpDetailView(SERVERS[0] as McpServerSummary);
    expect(view.key).toBe('github');
    expect(view.badge?.text).toBe('connected');
    expect(view.sections[1]?.lines).toContain('mcp__github__search');

    const empty = buildMcpDetailView(SERVERS[1] as McpServerSummary);
    expect(empty.sections[1]?.lines?.[0]).toContain('no tools');
    expect(empty.sections[0]?.fields?.find((field) => field.label === 'Error')?.tone).toBe(
      'danger',
    );
  });

  it('disabled 空态诚实', () => {
    expect(disabledMcpView().badge?.text).toBe('disabled');
  });

  it('命令返回列表视图；无控制面时返回不可用详情', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl();
    const listed = await runMcpCommand([], ctx);
    expect(listed.view?.view.kind).toBe('list');
    expect(listed.output).toContain('github');

    const disabled = await runMcpCommand([], makeCtx());
    expect(disabled.view?.view.kind).toBe('detail');
    expect(disabled.output).toContain('MCP is not enabled');
  });
});

describe('/mcp view actions', () => {
  it('Enter 打开详情', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl();
    const result = await runMcpViewAction(
      { actionId: 'inspect', selectionKey: 'github', viewKind: 'list' },
      ctx,
    );
    expect(result.view?.view.kind).toBe('detail');
    expect(result.output).toBeUndefined();
  });

  it('r 重连失败/可用 server 并回 toast', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl(async (name) => ({
      name,
      status: 'connected',
      tools: ['mcp__fs__read'],
    }));
    const result = await runMcpViewAction(
      { actionId: 'reconnect', selectionKey: 'fs', viewKind: 'list' },
      ctx,
    );
    expect(result.output).toContain('Reconnected MCP server "fs" (1 tools)');
  });

  it('r 对 disabled server 拒绝重连', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl();
    const result = await runMcpViewAction(
      { actionId: 'reconnect', selectionKey: 'off', viewKind: 'list' },
      ctx,
    );
    expect(result.output).toContain('disabled');
  });

  it('g 刷新返回新列表', async () => {
    const ctx = makeCtx();
    ctx.mcp = fakeControl();
    const result = await runMcpViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'list' },
      ctx,
    );
    expect(result.view?.view.kind).toBe('list');
  });
});
