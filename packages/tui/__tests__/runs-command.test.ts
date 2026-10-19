import { describe, expect, it } from 'bun:test';
import { mergeRuns, runRunsCommand, sortRuns } from '../src/commands/runs-command.js';
import type {
  DurableRunHandle,
  DurableRunOutcome,
  DurableRunSummary,
  DurableRunsControl,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

function run(
  id: string,
  updatedAt: number,
  status: DurableRunSummary['status'],
  extra: Partial<DurableRunSummary> = {},
): DurableRunSummary {
  return {
    run_id: id,
    session_id: `session-${id}`,
    status,
    updated_at: updatedAt,
    iteration: 2,
    preview: `preview ${id}`,
    ...extra,
  };
}

function fakeRuns(options: {
  running?: DurableRunSummary[];
  interrupted?: DurableRunSummary[];
  resume?: (runId: string) => Promise<DurableRunHandle>;
}) {
  const listCalls: Array<{ status?: string; limit?: number }> = [];
  const control: DurableRunsControl = {
    list: async (opts) => {
      listCalls.push({ status: opts?.status, limit: opts?.limit });
      return opts?.status === 'running' ? (options.running ?? []) : (options.interrupted ?? []);
    },
    resume:
      options.resume ??
      (async (runId) => ({
        runId,
        sessionId: 'session-target',
        done: Promise.resolve<DurableRunOutcome>({ status: 'completed' }),
        cancel: () => undefined,
      })),
  };
  return { control, listCalls };
}

describe('run sorting', () => {
  it('updated_at 倒序，同值 run_id 升序', () => {
    const sorted = sortRuns([
      run('b', 100, 'interrupted'),
      run('a', 100, 'interrupted'),
      run('c', 200, 'running'),
    ]);
    expect(sorted.map((item) => item.run_id)).toEqual(['c', 'a', 'b']);
  });

  it('合并 running + interrupted 后截断到 20', () => {
    const running = Array.from({ length: 15 }, (_, i) => run(`r${i}`, 1000 + i, 'running'));
    const interrupted = Array.from({ length: 15 }, (_, i) => run(`i${i}`, 2000 + i, 'interrupted'));
    const merged = mergeRuns(running, interrupted);
    expect(merged).toHaveLength(20);
    expect(merged[0]?.run_id).toBe('i14');
    expect(merged[14]?.run_id).toBe('i0');
    expect(merged[19]?.run_id).toBe('r10');
    expect(merged.filter((item) => item.status === 'running')).toHaveLength(5);
  });
});

describe('formatRuns', () => {});

describe('/runs command', () => {
  it('未注入控制面 -> 明确提示，不抛错', async () => {
    const result = await runRunsCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Durable runs are not enabled');
  });

  it('查询 running + interrupted 两次，按规则排序', async () => {
    const { control, listCalls } = fakeRuns({
      running: [run('live', 300, 'running')],
      interrupted: [run('tie-b', 100, 'interrupted'), run('tie-a', 100, 'interrupted')],
    });
    const ctx = makeCtx();
    ctx.runs = control;
    const result = await runRunsCommand([], ctx);
    expect(listCalls).toEqual([
      { status: 'running', limit: 20 },
      { status: 'interrupted', limit: 20 },
    ]);
    const output = result.output ?? '';
    expect(output.indexOf('live')).toBeLessThan(output.indexOf('tie-a'));
    expect(output.indexOf('tie-a')).toBeLessThan(output.indexOf('tie-b'));
    expect(output).toContain('running (live)');
  });

  it('resume 成功：返回 handle、切会话且不清 context', async () => {
    const { control } = fakeRuns({});
    let changedTo = '';
    const ctx = makeCtx({
      onSessionChange: (id) => {
        changedTo = id;
      },
    });
    ctx.runs = control;
    ctx.context.add({ role: 'user', content: 'keep me' });
    const result = await runRunsCommand(['resume', 'run-1'], ctx);
    expect(result.resumeRun?.runId).toBe('run-1');
    expect(result.nextState?.currentSessionId).toBe('session-target');
    expect(changedTo).toBe('session-target');
    expect(ctx.context.messages).toHaveLength(1);
  });

  it('稳定 code 走 error-classifier', async () => {
    const notFound = Object.assign(new Error('run run-1 not found'), { code: 'run_not_found' });
    const ctx = makeCtx();
    ctx.runs = fakeRuns({
      resume: async () => {
        throw notFound;
      },
    }).control;
    expect((await runRunsCommand(['resume', 'run-1'], ctx)).output ?? '').toContain('[not_found]');

    const running = new Error('run_already_running: concurrent resume');
    ctx.runs = fakeRuns({
      resume: async () => {
        throw running;
      },
    }).control;
    expect((await runRunsCommand(['resume', 'run-1'], ctx)).output ?? '').toContain('[conflict]');
  });

  it('参数校验', async () => {
    const ctx = makeCtx();
    ctx.runs = fakeRuns({}).control;
    expect((await runRunsCommand(['resume'], ctx)).output ?? '').toContain('Usage: /runs resume');
    expect((await runRunsCommand(['resume', 'a', 'b'], ctx)).output ?? '').toContain(
      'Usage: /runs resume',
    );
    expect((await runRunsCommand(['wat'], ctx)).output ?? '').toContain('Unknown /runs subcommand');
  });
});

describe('0.5 RPC 路径', () => {
  it('runs.list 走方法表并合并 running/interrupted', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          const status = (params as { status?: string }).status;
          return {
            runs:
              status === 'running' ? [run('r1', 20, 'running')] : [run('r2', 10, 'interrupted')],
          } as T;
        },
        subscribe: () => () => undefined,
      },
    });

    const result = await runRunsCommand([], ctx);
    expect(result.output).toContain('Durable runs (2');
    expect(calls).toEqual([
      { method: 'runs.list', params: { status: 'running', limit: 20 } },
      { method: 'runs.list', params: { status: 'interrupted', limit: 20 } },
    ]);
  });

  it('runs.resume 只取 id，run.completed 事件完成', async () => {
    const handlers = new Set<(notification: unknown) => void>();
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          if (method === 'runs.resume') return { run_id: 'r1', session_id: 's1' } as T;
          return {} as T;
        },
        subscribe(handler) {
          handlers.add(handler as (notification: unknown) => void);
          return () => handlers.delete(handler as (notification: unknown) => void);
        },
      },
    });

    const result = await runRunsCommand(['resume', 'run-1'], ctx);
    expect(result.nextState).toEqual({ currentSessionId: 's1' });
    expect(result.resumeRun?.runId).toBe('r1');
    expect(handlers.size).toBe(1);

    for (const handler of [...handlers]) {
      handler({
        method: 'events.event',
        params: { type: 'run.completed', run_id: 'r1', data: {} },
      });
    }
    await expect(result.resumeRun?.done).resolves.toEqual({ status: 'completed' });
    expect(handlers.size).toBe(0);

    result.resumeRun?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((call) => call.method === 'runs.cancel')).toBe(true);
  });

  it('runs.resume 失败事件带 error', async () => {
    const handlers = new Set<(notification: unknown) => void>();
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string): Promise<T> {
          if (method === 'runs.resume') return { run_id: 'r1', session_id: 's1' } as T;
          return {} as T;
        },
        subscribe(handler) {
          handlers.add(handler as (notification: unknown) => void);
          return () => handlers.delete(handler as (notification: unknown) => void);
        },
      },
    });

    const result = await runRunsCommand(['resume', 'run-1'], ctx);
    for (const handler of [...handlers]) {
      handler({
        method: 'events.event',
        params: { type: 'run.failed', run_id: 'r1', data: { error: 'boom' } },
      });
    }
    await expect(result.resumeRun?.done).resolves.toEqual({ status: 'failed', error: 'boom' });
  });
});
