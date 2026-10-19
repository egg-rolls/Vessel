import { describe, expect, it } from 'bun:test';
import {
  buildWorkflowDetailView,
  buildWorkflowRunsView,
  disabledWorkflowsView,
  runWorkflowsCommand,
  runWorkflowsViewAction,
  workflowDetailActions,
  workflowRunActions,
  workflowStatusLabel,
  workflowStepLines,
} from '../src/commands/workflows-command.js';
import type {
  WorkflowRunDetailLike,
  WorkflowRunStatusLike,
  WorkflowRunSummaryLike,
  WorkflowsControl,
} from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

function summary(
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
    started_at: NOW - 10_000,
    updated_at: updatedAt,
    ...extra,
  };
}

const DETAIL: WorkflowRunDetailLike = {
  ...summary('wf_1', NOW, 'failed', { error: 'step check failed' }),
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
  ],
};

function makeControl(overrides: Partial<WorkflowsControl> = {}) {
  const cancelCalls: string[] = [];
  const getCalls: string[] = [];
  const base: WorkflowsControl = {
    listRuns: async () => [],
    getRun: async (id) => {
      getCalls.push(id);
      return DETAIL;
    },
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
    cancel: async (id) => {
      cancelCalls.push(id);
      return base.cancel(id);
    },
  };
  return { control, cancelCalls, getCalls };
}

function ctxWith(control: WorkflowsControl) {
  const ctx = makeCtx();
  ctx.workflows = control;
  return ctx;
}

describe('/workflows view mapping', () => {
  it('列表行带短 id、状态 glyph、进度与 error，并有 show/resume/cancel/refresh 动作', () => {
    const view = buildWorkflowRunsView(
      [
        summary('wf_live', NOW - 60_000, 'running'),
        summary('wf_fail', NOW, 'failed', { error: 'boom' }),
      ],
      NOW,
    );
    expect(view.kind).toBe('table');
    expect(view.rows.map((row) => row.key)).toEqual(['wf_live', 'wf_fail']);
    expect(view.rows[0]?.cells.status).toBe('◐ running');
    expect(view.rows[0]?.cells.progress).toBe('2/4');
    expect(view.rows[1]?.cells.error).toBe('boom');
    expect(view.rows[0]?.tone).toBe('warn');
    expect(view.rows[1]?.tone).toBe('danger');
    const actions = workflowRunActions();
    expect(actions.map((action) => action.key)).toEqual(['enter', 'r', 'x', 'g']);
    expect(actions.find((action) => action.id === 'refresh')?.key).toBe('g');
  });

  it('状态标签覆盖 failed/completed/pending', () => {
    expect(workflowStatusLabel('running')).toBe('◐ running');
    expect(workflowStatusLabel('failed')).toBe('failed');
  });

  it('详情带 key、inputs 与 steps（步骤行限制宽度/行数）', () => {
    const view = buildWorkflowDetailView(DETAIL, NOW);
    expect(view.kind).toBe('detail');
    expect(view.key).toBe('wf_1');
    expect(view.badge?.text).toBe('failed');
    const fields = view.sections[0]?.fields ?? [];
    expect(fields.find((field) => field.label === 'Inputs')?.value).toContain('branch=main');
    expect(fields.find((field) => field.label === 'Error')?.tone).toBe('danger');
    const stepLines = view.sections[1]?.lines ?? [];
    expect(stepLines[0]).toContain('STEP');
    expect(stepLines.join('\n')).toContain('plan');
    expect(stepLines.join('\n')).toContain('exit code 1');
    expect(workflowDetailActions().map((action) => action.key)).toEqual(['r', 'x', 'g']);
  });

  it('步骤超过上限时截断并提示', () => {
    const many: WorkflowRunDetailLike = {
      ...DETAIL,
      steps: Array.from({ length: 5 }, (_, index) => ({
        id: `s${index}`,
        type: 'agent' as const,
        status: 'completed' as const,
        attempts: 1,
      })),
    };
    const lines = workflowStepLines(many, 2);
    expect(lines).toHaveLength(4); // header + 2 + more
    expect(lines.at(-1)).toContain('3 more steps');
  });

  it('disabled 空态诚实', () => {
    const view = disabledWorkflowsView();
    expect(view.badge?.text).toBe('disabled');
    expect(view.sections[0]?.lines?.[0]).toContain('workflow.enabled: false');
  });

  it('命令返回列表与详情视图', async () => {
    const { control } = makeControl({ listRuns: async () => [summary('wf_1', NOW, 'running')] });
    const list = await runWorkflowsCommand([], ctxWith(control));
    expect(list.view?.source).toBe('workflows');
    expect(list.view?.view.kind).toBe('table');

    const detail = await runWorkflowsCommand(['show', 'wf_1'], ctxWith(control));
    expect(detail.view?.view.kind).toBe('detail');
    expect(detail.output).toContain('Workflow run wf_1');
  });
});

describe('/workflows view actions', () => {
  it('Enter/show 打开详情', async () => {
    const { control, getCalls } = makeControl();
    const result = await runWorkflowsViewAction(
      { actionId: 'show', selectionKey: 'wf_1', viewKind: 'table' },
      ctxWith(control),
    );
    expect(getCalls).toEqual(['wf_1']);
    expect(result.view?.view.kind).toBe('detail');
  });

  it('详情 g 刷新复用 viewKey', async () => {
    const { control, getCalls } = makeControl();
    const result = await runWorkflowsViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'detail', viewKey: 'wf_1' },
      ctxWith(control),
    );
    expect(getCalls).toEqual(['wf_1']);
    expect(result.view?.view.kind).toBe('detail');
  });

  it('表格 g 刷新重载列表', async () => {
    const { control } = makeControl({ listRuns: async () => [summary('wf_1', NOW, 'running')] });
    const result = await runWorkflowsViewAction(
      { actionId: 'refresh', selectionKey: '', viewKind: 'table' },
      ctxWith(control),
    );
    expect(result.view?.view.kind).toBe('table');
  });

  it('r 恢复运行并返回句柄；x 调用控制面取消', async () => {
    const { control, cancelCalls } = makeControl();
    const ctx = ctxWith(control);
    const resumed = await runWorkflowsViewAction(
      { actionId: 'resume', selectionKey: 'wf_1', viewKind: 'table' },
      ctx,
    );
    expect(resumed.workflowRun?.workflowRunId).toBe('wf_1');

    const cancelled = await runWorkflowsViewAction(
      { actionId: 'cancel', selectionKey: '', viewKind: 'detail', viewKey: 'wf_9' },
      ctx,
    );
    expect(cancelCalls).toEqual(['wf_9']);
    expect(cancelled.output).toContain('Cancellation requested');
  });

  it('不存在的 run 返回稳定文案', async () => {
    const { control } = makeControl({ getRun: async () => null });
    const result = await runWorkflowsViewAction(
      { actionId: 'show', selectionKey: 'wf_x', viewKind: 'table' },
      ctxWith(control),
    );
    expect(result.output).toContain('Workflow run "wf_x" not found');
  });
});
