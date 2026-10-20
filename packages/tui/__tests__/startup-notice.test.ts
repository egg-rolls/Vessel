import { describe, expect, it } from 'bun:test';
import { buildStartupNotice, loadStartupNotice } from '../src/repl/startup-notice.js';
import type {
  DurableRunSummary,
  DurableRunsControl,
  FeishuControlLike,
  FeishuStatusLike,
  McpControl,
  McpServerSummary,
  WorkflowRunSummaryLike,
  WorkflowsControl,
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

const interruptedWorkflow = (id: string): WorkflowRunSummaryLike => ({
  workflow_run_id: id,
  workflow_name: 'wf',
  status: 'interrupted',
  step_count: 2,
  completed_steps: 1,
  started_at: 1,
  updated_at: 1,
});

const connectedFeishu: FeishuStatusLike = {
  connected: true,
  appIdMasked: 'cli_***',
  active_chats: 1,
  queued_messages: 0,
};

describe('buildStartupNotice', () => {
  it('两者都没有 / 都为空 -> null', () => {
    expect(buildStartupNotice({ mcpServers: null, interruptedRuns: null })).toBeNull();
    expect(buildStartupNotice({ mcpServers: [], interruptedRuns: [] })).toBeNull();
  });

  it('飞书已连接才出现；未连接不出现', () => {
    expect(
      buildStartupNotice({
        mcpServers: [],
        interruptedRuns: [],
        feishu: connectedFeishu,
      }),
    ).toBe('ℹ Feishu connected — /feishu');
    expect(
      buildStartupNotice({
        mcpServers: [],
        interruptedRuns: [],
        feishu: { ...connectedFeishu, connected: false },
      }),
    ).toBeNull();
  });

  it('0.5：非 default tenant 追加一段；default 不显示', () => {
    expect(buildStartupNotice({ mcpServers: null, interruptedRuns: null, tenantId: 'acme' })).toBe(
      'ℹ Tenant: acme — /tenant',
    );
    expect(
      buildStartupNotice({ mcpServers: null, interruptedRuns: null, tenantId: 'default' }),
    ).toBeNull();
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

  it('读取 interrupted workflow 与飞书状态', async () => {
    const ctx = makeCtx();
    let listOpts: unknown;
    ctx.workflows = {
      listRuns: async (opts) => {
        listOpts = opts;
        return [interruptedWorkflow('wf_1')];
      },
      getRun: async () => null,
      start: async () => {
        throw new Error('not used');
      },
      resume: async () => {
        throw new Error('not used');
      },
      cancel: async () => undefined,
    } satisfies WorkflowsControl;
    ctx.feishu = { status: () => connectedFeishu } satisfies FeishuControlLike;

    expect(await loadStartupNotice(ctx)).toBe(
      'ℹ 1 interrupted workflow run · Feishu connected — /workflows · /feishu',
    );
    expect(listOpts).toEqual({ status: 'interrupted', limit: 20 });
  });

  it('workflow 查询失败与 feishu status 抛错都静默降级', async () => {
    const ctx = makeCtx();
    ctx.workflows = {
      listRuns: async () => {
        throw new Error('boom');
      },
      getRun: async () => null,
      start: async () => {
        throw new Error('not used');
      },
      resume: async () => {
        throw new Error('not used');
      },
      cancel: async () => undefined,
    } satisfies WorkflowsControl;
    ctx.feishu = {
      status: () => {
        throw new Error('boom');
      },
    } satisfies FeishuControlLike;

    expect(await loadStartupNotice(ctx)).toBeNull();
  });

  it('未连接 feishu 不出现在横幅', async () => {
    const ctx = makeCtx();
    ctx.feishu = {
      status: () => ({ ...connectedFeishu, connected: false }),
    } satisfies FeishuControlLike;
    expect(await loadStartupNotice(ctx)).toBeNull();
  });

  it('0.5：从 ctx.tenant 读取 tenant 横幅', async () => {
    const ctx = makeCtx({ tenant: { tenant_id: 'acme' } });
    expect(await loadStartupNotice(ctx)).toBe('ℹ Tenant: acme — /tenant');
  });
});
