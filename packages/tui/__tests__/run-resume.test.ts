/**
 * /runs resume 的运行态归一化测试（executeResume）
 */

import { describe, expect, it } from 'bun:test';
import { executeResume } from '../src/repl/run-turn.js';
import type { DurableRunHandle, DurableRunOutcome } from '../src/repl-context.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHandle(done: Promise<DurableRunOutcome>) {
  const state = { cancels: 0 };
  const handle: DurableRunHandle = {
    runId: 'run-1',
    sessionId: 'session-1',
    done,
    cancel: () => {
      state.cancels += 1;
    },
  };
  return { handle, state };
}

describe('executeResume', () => {
  it('completed -> completed', async () => {
    const { handle } = makeHandle(Promise.resolve({ status: 'completed', message: 'ok' }));
    expect(await executeResume(handle, new AbortController())).toEqual({ status: 'completed' });
  });

  it('failed -> failed 并带回原始错误', async () => {
    const error = new Error('boom');
    const { handle } = makeHandle(Promise.resolve({ status: 'failed', error }));
    expect(await executeResume(handle, new AbortController())).toEqual({
      status: 'failed',
      error,
    });
  });

  it('outcome cancelled -> cancelled', async () => {
    const { handle } = makeHandle(Promise.resolve({ status: 'cancelled' }));
    expect(await executeResume(handle, new AbortController())).toEqual({ status: 'cancelled' });
  });

  it('abort -> handle.cancel() 恰好一次，并返回 cancelled', async () => {
    const pending = deferred<DurableRunOutcome>();
    const { handle, state } = makeHandle(pending.promise);
    const abort = new AbortController();

    const running = executeResume(handle, abort);
    abort.abort(new Error('Run cancelled by user'));
    expect(state.cancels).toBe(1);
    pending.resolve({ status: 'cancelled' });

    expect(await running).toEqual({ status: 'cancelled' });
    expect(state.cancels).toBe(1);
  });

  it('已 abort 的 controller -> 立即 cancel', async () => {
    const { handle, state } = makeHandle(Promise.resolve({ status: 'cancelled' }));
    const abort = new AbortController();
    abort.abort();
    expect(await executeResume(handle, abort)).toEqual({ status: 'cancelled' });
    expect(state.cancels).toBe(1);
  });

  it('done 意外 reject -> failed（不崩 REPL）', async () => {
    const error = new Error('unexpected');
    const { handle } = makeHandle(Promise.reject(error));
    expect(await executeResume(handle, new AbortController())).toEqual({
      status: 'failed',
      error,
    });
  });
});
