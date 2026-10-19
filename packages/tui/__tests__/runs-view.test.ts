import { describe, expect, it } from 'bun:test';
import {
  buildRunsView,
  disabledRunsView,
  runRunsCommand,
  runRunsViewAction,
  runStatusLabel,
  runsColumns,
  runsViewActions,
  shortRunId,
} from '../src/commands/runs-command.js';
import type {
  DurableRunOutcome,
  DurableRunSummary,
  DurableRunsControl,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

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
}): DurableRunsControl {
  return {
    list: async (opts) =>
      opts?.status === 'running' ? (options.running ?? []) : (options.interrupted ?? []),
    resume: async (runId) => ({
      runId,
      sessionId: 'session-target',
      done: Promise.resolve<DurableRunOutcome>({ status: 'completed' }),
      cancel: () => undefined,
    }),
  };
}

describe('/runs view mapping', () => {
  it('表格列覆盖 run/session/status/updated/iter/preview，窄屏优先保留关键列', () => {
    expect(runsColumns().map((column) => column.key)).toEqual([
      'run',
      'session',
      'status',
      'updated',
      'iter',
      'preview',
    ]);
    expect(runsColumns().find((column) => column.key === 'session')?.priority).toBe(2);
  });

  it('行带稳定 key、短 id、glyph+文本状态与相对时间', () => {
    const view = buildRunsView(
      [run('run-0123456789abcdefgh', NOW - 60_000, 'running'), run('old', NOW, 'interrupted')],
      NOW,
    );
    expect(view.kind).toBe('table');
    expect(view.title).toBe('Durable runs');
    expect(view.rows.map((row) => row.key)).toEqual(['run-0123456789abcdefgh', 'old']);
    expect(view.rows[0]?.cells.status).toBe('◐ running (live)');
    expect(view.rows[0]?.cells.run).toBe(shortRunId('run-0123456789abcdefgh'));
    expect(view.rows[1]?.cells.status).toBe('! interrupted');
    expect(view.rows[0]?.cells.updated).toBe('1m ago');
    expect(view.rows[0]?.cells.iter).toBe('2');
    expect(view.initialKey).toBe('run-0123456789abcdefgh');
  });

  it('状态标签与动作声明', () => {
    expect(runStatusLabel(run('r', 1, 'running'))).toContain('running');
    expect(runStatusLabel(run('r', 1, 'interrupted'))).toContain('interrupted');
    const actions = runsViewActions();
    expect(actions.map((action) => action.key)).toEqual(['enter', 'x', 'r']);
    expect(actions.find((action) => action.id === 'cancel')?.tone).toBe('danger');
  });

  it('空列表渲染空态；disabled 用诚实详情', () => {
    const empty = buildRunsView([], NOW);
    expect(empty.rows).toHaveLength(0);
    expect(empty.emptyText).toContain('No running or interrupted runs');
    const disabled = disabledRunsView();
    expect(disabled.badge?.text).toBe('disabled');
    expect(disabled.sections[0]?.lines?.[0]).toContain('durable.enabled: false');
  });

  it('命令返回视图，disabled 也有不可用详情', async () => {
    const disabled = await runRunsCommand([], makeCtx());
    expect(disabled.view?.source).toBe('runs');
    expect(disabled.view?.view.kind).toBe('detail');

    const ctx = makeCtx();
    ctx.runs = fakeRuns({ running: [run('live', NOW, 'running')] });
    const result = await runRunsCommand([], ctx);
    expect(result.output).toContain('Durable runs (1');
    expect(result.view?.view.kind).toBe('table');
    const view = result.view?.view;
    if (view?.kind !== 'table') throw new Error('expected table view');
    expect(view.rows[0]?.key).toBe('live');
  });
});

describe('/runs view actions', () => {
  it('refresh 重新拉取并返回新视图', async () => {
    const ctx = makeCtx();
    ctx.runs = fakeRuns({ interrupted: [run('old', NOW, 'interrupted')] });
    const result = await runRunsViewAction({ actionId: 'refresh', selectionKey: 'old' }, ctx);
    expect(result.view?.view.kind).toBe('table');
    const view = result.view?.view;
    if (view?.kind !== 'table') throw new Error('expected table view');
    expect(view.rows[0]?.key).toBe('old');
  });

  it('Enter 走既有 resume 路径并返回运行句柄', async () => {
    const ctx = makeCtx();
    ctx.runs = fakeRuns({ interrupted: [run('old', NOW, 'interrupted')] });
    const result = await runRunsViewAction({ actionId: 'enter', selectionKey: 'old' }, ctx);
    expect(result.resumeRun?.runId).toBe('old');
    expect(result.nextState?.currentSessionId).toBe('session-target');
  });

  it('x 通过 runs.cancel 取消并给出确认文本', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          return { cancelled: true } as T;
        },
        subscribe: () => () => undefined,
      },
      runs: fakeRuns({}),
    });
    const result = await runRunsViewAction({ actionId: 'cancel', selectionKey: 'r1' }, ctx);
    expect(calls).toEqual([{ method: 'runs.cancel', params: { run_id: 'r1' } }]);
    expect(result.output).toContain('Cancellation requested for run "r1"');
  });

  it('cancelled:false 时明确说明未在运行', async () => {
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(): Promise<T> {
          return { cancelled: false } as T;
        },
        subscribe: () => () => undefined,
      },
      runs: fakeRuns({}),
    });
    const result = await runRunsViewAction({ actionId: 'cancel', selectionKey: 'r1' }, ctx);
    expect(result.output).toContain('is not running');
  });

  it('无 RPC 时取消给明确提示，不发请求', async () => {
    const ctx = makeCtx();
    ctx.runs = fakeRuns({});
    const result = await runRunsViewAction({ actionId: 'cancel', selectionKey: 'r1' }, ctx);
    expect(result.output).toContain('requires the RPC control plane');
  });
});
