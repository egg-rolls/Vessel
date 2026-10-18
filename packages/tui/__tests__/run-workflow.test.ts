/**
 * /workflows run|resume 的运行态归一化测试（executeWorkflow）
 */

import { describe, expect, it } from 'bun:test';
import { executeWorkflow } from '../src/repl/run-turn.js';
import type { WorkflowOutcomeLike, WorkflowRunHandle } from '../src/repl-context.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHandle(done: Promise<WorkflowOutcomeLike>) {
  const state = { cancels: 0 };
  const handle: WorkflowRunHandle = {
    workflowRunId: 'wf_1',
    done,
    cancel: async () => {
      state.cancels += 1;
    },
  };
  return { handle, state };
}

describe('executeWorkflow', () => {
  it('completed -> completed', async () => {
    const { handle } = makeHandle(
      Promise.resolve({ workflow_run_id: 'wf_1', status: 'completed' }),
    );
    expect(await executeWorkflow(handle, new AbortController())).toEqual({ status: 'completed' });
  });

  it('failed -> failed 并带回原始错误', async () => {
    const { handle } = makeHandle(
      Promise.resolve({ workflow_run_id: 'wf_1', status: 'failed', error: 'boom' }),
    );
    expect(await executeWorkflow(handle, new AbortController())).toEqual({
      status: 'failed',
      error: 'boom',
    });
  });

  it('failed 且无 error -> 给出稳定回退', async () => {
    const { handle } = makeHandle(Promise.resolve({ workflow_run_id: 'wf_1', status: 'failed' }));
    const outcome = await executeWorkflow(handle, new AbortController());
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBeInstanceOf(Error);
    }
  });

  it('cancelled / interrupted 分别归一化', async () => {
    const cancelled = makeHandle(Promise.resolve({ workflow_run_id: 'wf_1', status: 'cancelled' }));
    expect(await executeWorkflow(cancelled.handle, new AbortController())).toEqual({
      status: 'cancelled',
    });

    const interrupted = makeHandle(
      Promise.resolve({ workflow_run_id: 'wf_1', status: 'interrupted' }),
    );
    expect(await executeWorkflow(interrupted.handle, new AbortController())).toEqual({
      status: 'interrupted',
    });
  });

  it('abort -> cancel() 恰好一次，并返回 cancelled', async () => {
    const pending = deferred<WorkflowOutcomeLike>();
    const { handle, state } = makeHandle(pending.promise);
    const abort = new AbortController();

    const running = executeWorkflow(handle, abort);
    abort.abort(new Error('Run cancelled by user'));
    expect(state.cancels).toBe(1);
    pending.resolve({ workflow_run_id: 'wf_1', status: 'cancelled' });

    expect(await running).toEqual({ status: 'cancelled' });
    expect(state.cancels).toBe(1);
  });

  it('已 abort 的 controller -> 立即 cancel', async () => {
    const { handle, state } = makeHandle(
      Promise.resolve({ workflow_run_id: 'wf_1', status: 'cancelled' }),
    );
    const abort = new AbortController();
    abort.abort();
    expect(await executeWorkflow(handle, abort)).toEqual({ status: 'cancelled' });
    expect(state.cancels).toBe(1);
  });

  it('cancel() reject 不产生未处理错误', async () => {
    const pending = deferred<WorkflowOutcomeLike>();
    const handle: WorkflowRunHandle = {
      workflowRunId: 'wf_1',
      done: pending.promise,
      cancel: async () => {
        throw new Error('cancel failed');
      },
    };
    const abort = new AbortController();
    const running = executeWorkflow(handle, abort);
    abort.abort();
    pending.resolve({ workflow_run_id: 'wf_1', status: 'cancelled' });
    expect(await running).toEqual({ status: 'cancelled' });
  });

  it('done 意外 reject -> failed（不崩 REPL）', async () => {
    const error = new Error('unexpected');
    const { handle } = makeHandle(Promise.reject(error));
    expect(await executeWorkflow(handle, new AbortController())).toEqual({
      status: 'failed',
      error,
    });
  });

  it('非终态（running）-> failed 防御', async () => {
    const { handle } = makeHandle(Promise.resolve({ workflow_run_id: 'wf_1', status: 'running' }));
    const outcome = await executeWorkflow(handle, new AbortController());
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(String(outcome.error)).toContain('unexpected workflow status');
    }
  });
});
