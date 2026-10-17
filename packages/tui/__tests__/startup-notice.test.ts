import { describe, expect, it } from 'bun:test';
import { buildStartupNotice, loadStartupNotice } from '../src/repl/startup-notice.js';
import type {
  DurableRunSummary,
  DurableRunsControl,
  McpControl,
  McpServerSummary,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const mcpServer = (name: string): McpServerSummary => ({
  name,
  status: 'connected',
  tools: [],
});

const interruptedRun = (id: string): DurableRunSummary => ({
  run_id: id,
  session_id: 'session',
  status: 'interrupted',
  updated_at: 1,
});

describe('buildStartupNotice', () => {
  it('两者都没有 / 都为空 -> null', () => {
    expect(buildStartupNotice({ mcpServers: null, interruptedRuns: null })).toBeNull();
    expect(buildStartupNotice({ mcpServers: [], interruptedRuns: [] })).toBeNull();
  });

  it('仅有 MCP server', () => {
    expect(
      buildStartupNotice({ mcpServers: [mcpServer('a'), mcpServer('b')], interruptedRuns: [] }),
    ).toBe('ℹ MCP: 2 servers — /mcp');
  });

  it('仅有 interrupted run，含单复数', () => {
    expect(buildStartupNotice({ mcpServers: [], interruptedRuns: [interruptedRun('r1')] })).toBe(
      'ℹ 1 interrupted run — /runs',
    );
    expect(
      buildStartupNotice({
        mcpServers: [],
        interruptedRuns: [interruptedRun('r1'), interruptedRun('r2')],
      }),
    ).toBe('ℹ 2 interrupted runs — /runs');
  });

  it('两者都有 -> 单行', () => {
    const line = buildStartupNotice({
      mcpServers: [mcpServer('a')],
      interruptedRuns: [interruptedRun('r1'), interruptedRun('r2')],
    });
    expect(line).toBe('ℹ MCP: 1 server · 2 interrupted runs — /mcp · /runs');
    expect(line).not.toContain('\n');
  });
});

describe('loadStartupNotice', () => {
  it('未注入控制面 -> null', async () => {
    expect(await loadStartupNotice(makeCtx())).toBeNull();
  });

  it('并行读取 MCP 与 interrupted run', async () => {
    const ctx = makeCtx();
    ctx.mcp = {
      list: async () => [mcpServer('a')],
      reconnect: async (name) => mcpServer(name),
      toolSource: () => null,
    } satisfies McpControl;
    ctx.runs = {
      list: async () => [interruptedRun('r1')],
      resume: async () => {
        throw new Error('not used');
      },
    } satisfies DurableRunsControl;

    expect(await loadStartupNotice(ctx)).toBe('ℹ MCP: 1 server · 1 interrupted run — /mcp · /runs');
  });

  it('单项失败静默降级，不影响另一项', async () => {
    const ctx = makeCtx();
    ctx.mcp = {
      list: async () => {
        throw new Error('boom');
      },
      reconnect: async (name) => mcpServer(name),
      toolSource: () => null,
    } satisfies McpControl;
    ctx.runs = {
      list: async () => [interruptedRun('r1')],
      resume: async () => {
        throw new Error('not used');
      },
    } satisfies DurableRunsControl;

    expect(await loadStartupNotice(ctx)).toBe('ℹ 1 interrupted run — /runs');
  });
});
