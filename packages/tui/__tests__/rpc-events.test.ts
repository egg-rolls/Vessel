import { describe, expect, it } from 'bun:test';
import type { RpcClientLike, RpcEventNotificationLike } from '../src/repl-context.js';
import {
  pollRunCompletion,
  waitForRunCompletion,
  waitForWorkflowCompletion,
} from '../src/rpc-events.js';

interface FakeRpc {
  rpc: RpcClientLike;
  emit(event: Record<string, unknown>): void;
  subscriberCount(): number;
  calls: Array<{ method: string; params?: unknown }>;
}

function makeFakeRpc(
  requestImpl?: (method: string, params?: unknown) => Promise<unknown>,
): FakeRpc {
  const handlers = new Set<(notification: RpcEventNotificationLike) => void>();
  const calls: Array<{ method: string; params?: unknown }> = [];

  const rpc: RpcClientLike = {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (requestImpl) return (await requestImpl(method, params)) as T;
      throw new Error(`unexpected request: ${method}`);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  return {
    rpc,
    emit(event) {
      for (const handler of [...handlers]) {
        handler({ method: 'events.event', params: event });
      }
    },
    subscriberCount: () => handlers.size,
    calls,
  };
}

describe('waitForRunCompletion', () => {
  it('匹配 run.completed 并解绑', async () => {
    const fake = makeFakeRpc();
    const waiter = waitForRunCompletion(fake.rpc, 'run_1');

    fake.emit({ type: 'run.completed', run_id: 'run_2', data: { run_id: 'run_2' } });
    fake.emit({ type: 'tool.call.started', run_id: 'run_1', data: {} });
    expect(fake.subscriberCount()).toBe(1);

    fake.emit({ type: 'run.completed', run_id: 'run_1', data: { run_id: 'run_1' } });

    await expect(waiter.done).resolves.toEqual({ status: 'completed' });
    expect(fake.subscriberCount()).toBe(0);
  });

  it('run.failed 带出 data.error', async () => {
    const fake = makeFakeRpc();
    const waiter = waitForRunCompletion(fake.rpc, 'run_1');
    fake.emit({ type: 'run.failed', run_id: 'run_1', data: { error: 'boom' } });
    await expect(waiter.done).resolves.toEqual({ status: 'failed', error: 'boom' });
  });

  it('run.cancelled 映射为 cancelled', async () => {
    const fake = makeFakeRpc();
    const waiter = waitForRunCompletion(fake.rpc, 'run_1');
    fake.emit({ type: 'run.cancelled', run_id: 'run_1', data: {} });
    await expect(waiter.done).resolves.toEqual({ status: 'cancelled' });
  });

  it('stop() 返回 cancelled 并解绑', async () => {
    const fake = makeFakeRpc();
    const waiter = waitForRunCompletion(fake.rpc, 'run_1');
    waiter.stop();
    await expect(waiter.done).resolves.toEqual({ status: 'cancelled' });
    expect(fake.subscriberCount()).toBe(0);
  });

  it('signal abort 返回 cancelled', async () => {
    const fake = makeFakeRpc();
    const controller = new AbortController();
    const waiter = waitForRunCompletion(fake.rpc, 'run_1', controller.signal);
    controller.abort();
    await expect(waiter.done).resolves.toEqual({ status: 'cancelled' });
    expect(fake.subscriberCount()).toBe(0);
  });
});

describe('waitForWorkflowCompletion', () => {
  it('匹配 data.workflow_run_id 的终态', async () => {
    const fake = makeFakeRpc();
    const waiter = waitForWorkflowCompletion(fake.rpc, 'wf_1');

    fake.emit({ type: 'workflow.step.completed', run_id: 'wf_2', data: {} });
    fake.emit({
      type: 'workflow.completed',
      run_id: 'wf_1',
      data: { workflow_run_id: 'wf_1' },
    });

    await expect(waiter.done).resolves.toEqual({ status: 'completed' });
    expect(fake.subscriberCount()).toBe(0);
  });

  it('workflow.failed / workflow.interrupted 终态', async () => {
    const failed = makeFakeRpc();
    const failedWaiter = waitForWorkflowCompletion(failed.rpc, 'wf_1');
    failed.emit({
      type: 'workflow.failed',
      run_id: 'wf_1',
      data: { workflow_run_id: 'wf_1', error: 'step failed' },
    });
    await expect(failedWaiter.done).resolves.toEqual({
      status: 'failed',
      error: 'step failed',
    });

    const interrupted = makeFakeRpc();
    const interruptedWaiter = waitForWorkflowCompletion(interrupted.rpc, 'wf_1');
    interrupted.emit({
      type: 'workflow.interrupted',
      run_id: 'wf_1',
      data: { workflow_run_id: 'wf_1' },
    });
    await expect(interruptedWaiter.done).resolves.toEqual({ status: 'interrupted' });
  });
});

describe('pollRunCompletion', () => {
  it('running -> completed', async () => {
    let calls = 0;
    const fake = makeFakeRpc(async (method) => {
      expect(method).toBe('runs.get');
      calls += 1;
      return calls === 1 ? { status: 'running' } : { status: 'completed' };
    });

    await expect(pollRunCompletion(fake.rpc, 'run_1', { intervalMs: 1 })).resolves.toEqual({
      status: 'completed',
    });
    expect(calls).toBe(2);
  });

  it('cancelled / failed 带错误', async () => {
    const cancelled = makeFakeRpc(async () => ({ status: 'cancelled' }));
    await expect(pollRunCompletion(cancelled.rpc, 'run_1', { intervalMs: 1 })).resolves.toEqual({
      status: 'cancelled',
    });

    const failed = makeFakeRpc(async () => ({ status: 'failed', error: 'bad' }));
    await expect(pollRunCompletion(failed.rpc, 'run_1', { intervalMs: 1 })).resolves.toEqual({
      status: 'failed',
      error: 'bad',
    });
  });

  it('interrupted 按 failed 返回', async () => {
    const fake = makeFakeRpc(async () => ({ status: 'interrupted' }));
    await expect(pollRunCompletion(fake.rpc, 'run_1', { intervalMs: 1 })).resolves.toEqual({
      status: 'failed',
      error: 'run interrupted',
    });
  });

  it('已 abort 时不发请求', async () => {
    const fake = makeFakeRpc();
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollRunCompletion(fake.rpc, 'run_1', { signal: controller.signal, intervalMs: 1 }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(fake.calls).toHaveLength(0);
  });
});
