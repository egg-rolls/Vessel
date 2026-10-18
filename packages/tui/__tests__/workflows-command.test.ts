import { describe, expect, it } from 'bun:test';
import {
  formatWorkflowDetail,
  formatWorkflowOutcome,
  formatWorkflowRuns,
  parseWorkflowListArgs,
  parseWorkflowRunArgs,
  runWorkflowsCommand,
  sortWorkflowRuns,
} from '../src/commands/workflows-command.js';
import type {
  RpcClientLike,
  RpcEventNotificationLike,
  WorkflowRunDetailLike,
  WorkflowRunStatusLike,
  WorkflowRunSummaryLike,
  WorkflowsControl,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

function run(
  id: string,
  updatedAt: number,
  status: WorkflowRunStatusLike,
  extra: Partial<WorkflowRunSummaryLike> = {},
): WorkflowRunSummaryLike {
  return {
    workflow_run_id: id,
    workflow_name: `wf-${id}`,
    status,
    step_count: 4,
    completed_steps: 2,
    started_at: 1000,
    updated_at: updatedAt,
    ...extra,
  };
}

const detail: WorkflowRunDetailLike = {
  ...run('wf_1', 5000, 'failed', { error: 'step check failed' }),
  definition_path: '/tmp/release-check.yaml',
  inputs: { branch: 'main', env: 'staging' },
  steps: [
    {
      id: 'plan',
      type: 'agent',
      status: 'completed',
      attempts: 1,
      started_at: 1000,
      finished_at: 1234,
      output_preview: 'wrote 4 files',
    },
    {
      id: 'check',
      type: 'tool',
      status: 'failed',
      attempts: 2,
      started_at: 2000,
      finished_at: 3000,
      error: 'exit code 1',
    },
    { id: 'summarize', type: 'agent', status: 'skipped', attempts: 0 },
  ],
};

function makeControl(overrides: Partial<WorkflowsControl> = {}) {
  const listCalls: Array<{ status?: WorkflowRunStatusLike; limit?: number }> = [];
  const cancelCalls: string[] = [];
  const base: WorkflowsControl = {
    listRuns: async () => [],
    getRun: async () => null,
    start: async (name) => ({
      workflowRunId: `wf_${name}`,
      done: Promise.resolve({ workflow_run_id: `wf_${name}`, status: 'completed' }),
    }),
    resume: async (id) => ({
      workflowRunId: id,
      done: Promise.resolve({ workflow_run_id: id, status: 'completed' }),
    }),
    cancel: async () => undefined,
    ...overrides,
  };
  const control: WorkflowsControl = {
    ...base,
    listRuns: async (opts) => {
      listCalls.push(opts ?? {});
      return base.listRuns(opts);
    },
    cancel: async (id) => {
      cancelCalls.push(id);
      return base.cancel(id);
    },
  };
  return { control, listCalls, cancelCalls };
}

function ctxWith(control: WorkflowsControl) {
  const ctx = makeCtx();
  ctx.workflows = control;
  return ctx;
}

describe('workflow run sorting and formatting', () => {
  it('updated_at 倒序，同值 workflow_run_id 升序', () => {
    const sorted = sortWorkflowRuns([
      run('b', 100, 'interrupted'),
      run('a', 100, 'interrupted'),
      run('c', 200, 'running'),
    ]);
    expect(sorted.map((item) => item.workflow_run_id)).toEqual(['c', 'a', 'b']);
  });

  it('列表渲染 name / status / 进度 / error', () => {
    const output = formatWorkflowRuns(
      [run('wf_live', 1000, 'running'), run('wf_fail', 500, 'failed', { error: 'boom' })],
      1000 + 60_000,
    );
    expect(output).toContain('Workflow runs (2, newest first)');
    expect(output).toContain('wf_live');
    expect(output).toContain('wf-wf_live');
    expect(output).toContain('running');
    expect(output).toContain('2/4');
    expect(output).toContain('1m ago');
    expect(output).toContain('boom');
  });

  it('空列表给明确提示（无过滤 / 有过滤）', () => {
    expect(formatWorkflowRuns([])).toContain('No workflow runs');
    expect(formatWorkflowRuns([], Date.now(), 'failed')).toContain(
      'No workflow runs with status "failed"',
    );
  });

  it('详情渲染状态、inputs、步骤、耗时与错误', () => {
    const output = formatWorkflowDetail(detail, 10_000);
    expect(output).toContain('Workflow run wf_1 (wf-wf_1)');
    expect(output).toContain('2/4 steps');
    expect(output).toContain('/tmp/release-check.yaml');
    expect(output).toContain('branch=main, env=staging');
    expect(output).toContain('step check failed');
    expect(output).toContain('plan');
    expect(output).toContain('234ms');
    expect(output).toContain('wrote 4 files');
    expect(output).toContain('exit code 1');
    expect(output).toContain('skipped');
  });

  it('详情无 inputs / 无步骤时给出占位', () => {
    const output = formatWorkflowDetail({ ...detail, inputs: {}, steps: [] }, 10_000);
    expect(output).toContain('inputs:      -');
    expect(output).toContain('(no steps)');
  });
});

describe('workflow argument parsing', () => {
  it('list 默认 limit=20，支持 --status / --limit', () => {
    expect(parseWorkflowListArgs([])).toEqual({ ok: true, value: { limit: 20 } });
    expect(parseWorkflowListArgs(['--status', 'failed', '--limit', '5'])).toEqual({
      ok: true,
      value: { status: 'failed', limit: 5 },
    });
  });

  it('list 拒绝非法 status / limit / 未知参数', () => {
    expect(parseWorkflowListArgs(['--status', 'nope']).ok).toBe(false);
    expect(parseWorkflowListArgs(['--limit', '0']).ok).toBe(false);
    expect(parseWorkflowListArgs(['--limit', '21']).ok).toBe(false);
    expect(parseWorkflowListArgs(['--limit', 'abc']).ok).toBe(false);
    expect(parseWorkflowListArgs(['--watch']).ok).toBe(false);
  });

  it('run 解析 name 与 inputs（值可含 =）', () => {
    expect(parseWorkflowRunArgs(['release-check'])).toEqual({
      ok: true,
      value: { name: 'release-check' },
    });
    expect(
      parseWorkflowRunArgs(['release-check', '--input', 'branch=main', '--input', 'expr=1=2']),
    ).toEqual({
      ok: true,
      value: { name: 'release-check', inputs: { branch: 'main', expr: '1=2' } },
    });
  });

  it('run 拒绝路径名与坏 input', () => {
    expect(parseWorkflowRunArgs([]).ok).toBe(false);
    expect(parseWorkflowRunArgs(['../evil']).ok).toBe(false);
    expect(parseWorkflowRunArgs(['a/b']).ok).toBe(false);
    expect(parseWorkflowRunArgs(['.']).ok).toBe(false);
    expect(parseWorkflowRunArgs(['release-check', '--input', 'broken']).ok).toBe(false);
    expect(parseWorkflowRunArgs(['release-check', '--watch']).ok).toBe(false);
  });
});

describe('/workflows command', () => {
  it('未注入控制面 -> 明确提示，不抛错', async () => {
    const result = await runWorkflowsCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Workflows are not enabled');
  });

  it('无参 / list 都查询默认 limit=20，排序并截断', async () => {
    const runs = Array.from({ length: 25 }, (_, index) =>
      run(`wf_${String(index).padStart(2, '0')}`, index, 'completed'),
    );
    const { control, listCalls } = makeControl({ listRuns: async () => runs });
    const ctx = ctxWith(control);

    const result = await runWorkflowsCommand([], ctx);
    expect(listCalls).toEqual([{ limit: 20 }]);
    const output = result.output ?? '';
    expect(output).toContain('Workflow runs (20, newest first)');
    expect(output).toContain('wf_24');
    expect(output).not.toContain('wf_04');
  });

  it('list --status --limit 透传控制面', async () => {
    const { control, listCalls } = makeControl({ listRuns: async () => [] });
    const ctx = ctxWith(control);
    const result = await runWorkflowsCommand(['list', '--status', 'failed', '--limit', '5'], ctx);
    expect(listCalls).toEqual([{ status: 'failed', limit: 5 }]);
    expect(result.output ?? '').toContain('No workflow runs with status "failed"');
  });

  it('list 参数错误返回 usage', async () => {
    const { control } = makeControl();
    const ctx = ctxWith(control);
    expect((await runWorkflowsCommand(['list', '--limit', '99'], ctx)).output ?? '').toContain(
      '--limit must be an integer between 1 and 20',
    );
    expect((await runWorkflowsCommand(['list', '--status', 'nope'], ctx)).output ?? '').toContain(
      'Invalid status',
    );
  });

  it('show 渲染详情；null 给 not found', async () => {
    const { control } = makeControl({ getRun: async () => detail });
    const ctx = ctxWith(control);
    expect((await runWorkflowsCommand(['show', 'wf_1'], ctx)).output ?? '').toContain(
      'exit code 1',
    );

    const missing = ctxWith(makeControl({ getRun: async () => null }).control);
    expect((await runWorkflowsCommand(['show', 'wf_x'], missing)).output ?? '').toContain(
      'Workflow run "wf_x" not found',
    );
  });

  it('run 启动并返回可取消句柄', async () => {
    let startedName = '';
    let startedInputs: Record<string, string> | undefined;
    const { control, cancelCalls } = makeControl({
      start: async (name, opts) => {
        startedName = name;
        startedInputs = opts?.inputs;
        return {
          workflowRunId: 'wf_started',
          done: Promise.resolve({ workflow_run_id: 'wf_started', status: 'completed' }),
        };
      },
    });
    const ctx = ctxWith(control);
    const result = await runWorkflowsCommand(
      ['run', 'release-check', '--input', 'branch=main'],
      ctx,
    );

    expect(startedName).toBe('release-check');
    expect(startedInputs).toEqual({ branch: 'main' });
    expect(result.output ?? '').toContain('Started workflow run "wf_started"');
    expect(result.workflowRun?.workflowRunId).toBe('wf_started');
    await result.workflowRun?.cancel();
    expect(cancelCalls).toEqual(['wf_started']);
  });

  it('run 参数错误不调用控制面', async () => {
    let starts = 0;
    const { control } = makeControl({
      start: async () => {
        starts += 1;
        return {
          workflowRunId: 'wf_x',
          done: Promise.resolve({ workflow_run_id: 'wf_x', status: 'completed' }),
        };
      },
    });
    const ctx = ctxWith(control);
    expect((await runWorkflowsCommand(['run'], ctx)).output ?? '').toContain(
      'Usage: /workflows run',
    );
    expect((await runWorkflowsCommand(['run', '../evil'], ctx)).output ?? '').toContain(
      'Invalid workflow name',
    );
    expect(starts).toBe(0);
  });

  it('resume 启动并返回句柄；稳定 code 走分类器', async () => {
    const { control } = makeControl();
    const ctx = ctxWith(control);
    const result = await runWorkflowsCommand(['resume', 'wf_1'], ctx);
    expect(result.output ?? '').toContain('Resuming workflow run "wf_1"');
    expect(result.workflowRun?.workflowRunId).toBe('wf_1');

    const failing = ctxWith(
      makeControl({
        resume: async () => {
          throw Object.assign(new Error('concurrent resume'), {
            code: 'workflow_already_running',
          });
        },
      }).control,
    );
    expect((await runWorkflowsCommand(['resume', 'wf_1'], failing)).output ?? '').toContain(
      '[conflict]',
    );
  });

  it('cancel 调用控制面并给出确认', async () => {
    const { control, cancelCalls } = makeControl();
    const ctx = ctxWith(control);
    const result = await runWorkflowsCommand(['cancel', 'wf_9'], ctx);
    expect(cancelCalls).toEqual(['wf_9']);
    expect(result.output ?? '').toContain('Cancellation requested for workflow run "wf_9"');

    const failing = ctxWith(
      makeControl({
        cancel: async () => {
          throw new Error('workflow_not_found');
        },
      }).control,
    );
    expect((await runWorkflowsCommand(['cancel', 'wf_9'], failing)).output ?? '').toContain(
      '[not_found]',
    );
  });

  it('子命令参数校验', async () => {
    const ctx = ctxWith(makeControl().control);
    expect((await runWorkflowsCommand(['show'], ctx)).output ?? '').toContain(
      'Usage: /workflows show <id>',
    );
    expect((await runWorkflowsCommand(['resume', 'a', 'b'], ctx)).output ?? '').toContain(
      'Usage: /workflows resume <id>',
    );
    expect((await runWorkflowsCommand(['cancel'], ctx)).output ?? '').toContain(
      'Usage: /workflows cancel <id>',
    );
    expect((await runWorkflowsCommand(['wat'], ctx)).output ?? '').toContain(
      'Unknown /workflows subcommand "wat"',
    );
  });

  it('list 失败走 error-classifier', async () => {
    const ctx = ctxWith(
      makeControl({
        listRuns: async () => {
          throw new Error('fetch failed: ECONNREFUSED');
        },
      }).control,
    );
    expect((await runWorkflowsCommand([], ctx)).output ?? '').toContain('[network]');
  });
});

describe('formatWorkflowOutcome', () => {
  it('四种结局', () => {
    expect(formatWorkflowOutcome('wf_1', { status: 'completed' })).toBe(
      '✓ Workflow run "wf_1" completed.',
    );
    expect(formatWorkflowOutcome('wf_1', { status: 'cancelled' })).toBe(
      '⏹ Workflow run "wf_1" cancelled.',
    );
    expect(formatWorkflowOutcome('wf_1', { status: 'interrupted' })).toContain(
      'Resume with /workflows resume wf_1',
    );
    expect(
      formatWorkflowOutcome('wf_1', { status: 'failed', error: new Error('workflow_invalid') }),
    ).toContain('[invalid]');
  });
});

function makeWorkflowRpc(handler: (method: string, params?: unknown) => unknown): RpcClientLike & {
  calls: Array<{ method: string; params?: unknown }>;
  handlers: Set<(notification: RpcEventNotificationLike) => void>;
} {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const handlers = new Set<(notification: RpcEventNotificationLike) => void>();
  return {
    calls,
    handlers,
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      return (await handler(method, params)) as T;
    },
    subscribe(handlerFn) {
      handlers.add(handlerFn);
      return () => handlers.delete(handlerFn);
    },
  };
}

describe('0.5 RPC 路径', () => {
  it('workflow.list 走方法表', async () => {
    const rpc = makeWorkflowRpc(() => ({ workflows: [run('wf_1', 10, 'running')] }));
    const result = await runWorkflowsCommand(['list'], makeCtx({ rpc }));
    expect(result.output).toContain('Workflow runs (1');
    expect(rpc.calls[0]).toEqual({ method: 'workflow.list', params: { limit: 20 } });
  });

  it('workflow.get 返回详情', async () => {
    const detail: WorkflowRunDetailLike = {
      ...run('wf_1', 10, 'completed'),
      definition_path: '/wf/demo.yaml',
      inputs: { topic: 'x' },
      steps: [
        {
          id: 'step1',
          type: 'agent',
          status: 'completed',
          attempts: 1,
          output_preview: 'ok',
        },
      ],
    };
    const rpc = makeWorkflowRpc(() => ({ workflow: detail }));
    const result = await runWorkflowsCommand(['show', 'wf_1'], makeCtx({ rpc }));
    expect(result.output).toContain('Workflow run wf_1');
    expect(result.output).toContain('definition:  /wf/demo.yaml');
    expect(result.output).toContain('step1');
    expect(rpc.calls[0]).toEqual({
      method: 'workflow.get',
      params: { workflow_run_id: 'wf_1' },
    });
  });

  it('workflow.start 只取 id，完成走事件', async () => {
    const rpc = makeWorkflowRpc(() => ({ workflow_run_id: 'wf_new' }));
    const result = await runWorkflowsCommand(['run', 'demo'], makeCtx({ rpc }));

    expect(result.workflowRun?.workflowRunId).toBe('wf_new');
    expect(rpc.calls[0]).toEqual({ method: 'workflow.start', params: { name: 'demo' } });
    expect(rpc.handlers.size).toBe(1);

    for (const handler of [...rpc.handlers]) {
      handler({
        method: 'events.event',
        params: {
          type: 'workflow.completed',
          run_id: 'wf_new',
          data: { workflow_run_id: 'wf_new' },
        },
      });
    }
    await expect(result.workflowRun?.done).resolves.toMatchObject({
      workflow_run_id: 'wf_new',
      status: 'completed',
    });
    expect(rpc.handlers.size).toBe(0);
  });

  it('workflow.resume 与 cancel 走方法表', async () => {
    const rpc = makeWorkflowRpc((method) => {
      if (method === 'workflow.resume') return { workflow_run_id: 'wf_9' };
      return {};
    });
    const resumed = await runWorkflowsCommand(['resume', 'wf_9'], makeCtx({ rpc }));
    expect(resumed.workflowRun?.workflowRunId).toBe('wf_9');

    const cancelResult = await runWorkflowsCommand(['cancel', 'wf_9'], makeCtx({ rpc }));
    expect(cancelResult.output).toContain('Cancellation requested');
    expect(rpc.calls.some((call) => call.method === 'workflow.cancel')).toBe(true);
  });

  it('RPC 错误按 code 展示', async () => {
    const rpc = makeWorkflowRpc(() => {
      throw { code: 'not_found', message: 'workflow not found' };
    });
    const result = await runWorkflowsCommand(['show', 'wf_x'], makeCtx({ rpc }));
    expect(result.output).toContain('✗ [not_found] workflow not found');
  });
});
