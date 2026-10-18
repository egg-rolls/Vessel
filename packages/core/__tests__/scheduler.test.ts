import { describe, expect, it } from 'bun:test';
import type { AgentHandle, RunHandle, RunStatus, ScheduledTask } from '../src/kernel/index';
import { InProcessRuntimeHost, InProcessScheduler } from '../src/kernel/index';
import type { ChatRequest, LLMProvider, LLMResponse } from '../src/types/provider';

/** 可控 Provider：保持挂起，直到测试 respond / 取消 */
class ControlledProvider implements LLMProvider {
  private readonly resolvers: Array<(response: LLMResponse) => void> = [];
  private readonly starters: Array<() => void> = [];

  waitForRequest(): Promise<void> {
    return new Promise((resolve) => {
      this.starters.push(resolve);
    });
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.starters.shift()?.();

    return await new Promise<LLMResponse>((resolve, reject) => {
      const signal = req.signal;
      const resolver = (response: LLMResponse) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };
      const onAbort = () => {
        const index = this.resolvers.indexOf(resolver);
        if (index >= 0) this.resolvers.splice(index, 1);
        reject(new Error(String(signal?.reason ?? 'aborted')));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resolvers.push(resolver);
    });
  }

  respond(content = 'done'): void {
    this.resolvers.shift()?.({ content, finish_reason: 'stop' });
  }
}

async function spawnControlled(host: InProcessRuntimeHost, id: string) {
  const provider = new ControlledProvider();
  const agent = await host.spawn({ id, provider, model: 'm' });
  return { provider, agent };
}

describe('Scheduler 并发与队列（R2）', () => {
  it('默认全局并发 1：不同成员也按 FIFO 排队', async () => {
    const host = new InProcessRuntimeHost();
    const a = await spawnControlled(host, 'a');
    const b = await spawnControlled(host, 'b');

    const aStarted = a.provider.waitForRequest();
    const runA = await a.agent.run('a');
    await aStarted;
    expect(runA.status()).toBe('running');

    const runB = await b.agent.run('b');
    expect(runB.status()).toBe('queued');
    expect(host.scheduler.stats()).toMatchObject({ queued: 1, running: 1 });

    const bStarted = b.provider.waitForRequest();
    a.provider.respond('a-done');
    await expect(runA.result).resolves.toBe('a-done');
    await bStarted;
    expect(runB.status()).toBe('running');

    b.provider.respond('b-done');
    await expect(runB.result).resolves.toBe('b-done');
    await Promise.resolve();
    expect(host.scheduler.stats().completed).toBe(2);

    await host.close();
  });

  it('maxConcurrency 可配置为 2', async () => {
    const host = new InProcessRuntimeHost({ schedulerOptions: { maxConcurrency: 2 } });
    const a = await spawnControlled(host, 'a');
    const b = await spawnControlled(host, 'b');

    const aStarted = a.provider.waitForRequest();
    const bStarted = b.provider.waitForRequest();
    const runA = await a.agent.run('a');
    const runB = await b.agent.run('b');

    await aStarted;
    await bStarted;
    expect(runA.status()).toBe('running');
    expect(runB.status()).toBe('running');
    expect(host.scheduler.stats().running).toBe(2);

    a.provider.respond('a-done');
    b.provider.respond('b-done');
    await expect(runA.result).resolves.toBe('a-done');
    await expect(runB.result).resolves.toBe('b-done');
    await Promise.resolve();
    expect(host.scheduler.stats().completed).toBe(2);

    await host.close();
  });

  it('同成员串行：第二个 run 排队，第一个完成后启动', async () => {
    const host = new InProcessRuntimeHost();
    const a = await spawnControlled(host, 'a');

    const firstStarted = a.provider.waitForRequest();
    const first = await a.agent.run('first');
    await firstStarted;

    const second = await a.agent.run('second');
    expect(second.status()).toBe('queued');
    expect(host.scheduler.stats().queued).toBe(1);

    const secondStarted = a.provider.waitForRequest();
    a.provider.respond('first-done');
    await expect(first.result).resolves.toBe('first-done');
    await secondStarted;
    expect(second.status()).toBe('running');

    a.provider.respond('second-done');
    await expect(second.result).resolves.toBe('second-done');

    await host.close();
  });

  it('排队取消：不消耗执行槽位，计入 cancelled', async () => {
    const host = new InProcessRuntimeHost();
    const a = await spawnControlled(host, 'a');
    const b = await spawnControlled(host, 'b');

    const aStarted = a.provider.waitForRequest();
    const runA = await a.agent.run('a');
    await aStarted;

    const runB = await b.agent.run('b');
    expect(runB.status()).toBe('queued');

    expect(host.scheduler.cancel(runB.id, 'drop')).toBe(true);
    await expect(runB.result).rejects.toThrow();
    expect(host.scheduler.stats()).toMatchObject({ queued: 0, running: 1, cancelled: 1 });

    a.provider.respond('a-done');
    await expect(runA.result).resolves.toBe('a-done');
    await Promise.resolve();
    expect(host.scheduler.stats().completed).toBe(1);

    await host.close();
  });

  it('运行取消：释放槽位并计入 cancelled', async () => {
    const host = new InProcessRuntimeHost();
    const a = await spawnControlled(host, 'a');

    const started = a.provider.waitForRequest();
    const run = await a.agent.run('a');
    await started;

    expect(host.scheduler.cancel(run.id, 'stop')).toBe(true);
    await expect(run.result).rejects.toThrow();
    await Promise.resolve();
    expect(host.scheduler.stats()).toMatchObject({ running: 0, cancelled: 1 });

    await host.close();
  });

  it('队列上限：超过 maxQueueSize 时拒绝', async () => {
    const host = new InProcessRuntimeHost({
      schedulerOptions: { maxConcurrency: 1, maxQueueSize: 1 },
    });
    const a = await spawnControlled(host, 'a');
    const b = await spawnControlled(host, 'b');
    const c = await spawnControlled(host, 'c');

    const aStarted = a.provider.waitForRequest();
    const runA = await a.agent.run('a');
    await aStarted;

    const runB = await b.agent.run('b');
    expect(runB.status()).toBe('queued');

    await expect(c.agent.run('c')).rejects.toThrow('scheduler queue is full');

    host.scheduler.cancel(runB.id);
    host.scheduler.cancel(runA.id);
    await host.close();
  });

  it('close 清理排队与运行中的 run', async () => {
    const host = new InProcessRuntimeHost();
    const a = await spawnControlled(host, 'a');
    const b = await spawnControlled(host, 'b');

    const aStarted = a.provider.waitForRequest();
    const runA = await a.agent.run('a');
    await aStarted;
    const runB = await b.agent.run('b');
    expect(runB.status()).toBe('queued');

    await host.scheduler.close();
    await expect(runA.result).rejects.toThrow();
    await expect(runB.result).rejects.toThrow();
    expect(host.scheduler.stats()).toMatchObject({ queued: 0, running: 0, cancelled: 2 });

    await host.close();
  });
});

/** 真实 RunHandle 的替身：记录 cancel 次数 */
class FakeRunHandle implements RunHandle {
  readonly result: Promise<string>;
  private state: RunStatus = 'running';
  cancelCalls = 0;
  private resolveResult!: (value: string) => void;
  private rejectResult!: (reason?: unknown) => void;

  constructor(
    readonly id: string,
    readonly agentId = 'a',
    readonly sessionId = 's',
  ) {
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => {});
  }

  status(): RunStatus {
    return this.state;
  }

  usage(): undefined {
    return undefined;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.state = 'cancelled';
    this.rejectResult(new Error('cancelled'));
  }

  finish(value = 'done'): void {
    this.state = 'completed';
    this.resolveResult(value);
  }
}

describe('Scheduler 取消竞态（0.3 回归）', () => {
  it('executor 尚未 attach 时 cancel：真实 handle 补发取消且只结算一次', async () => {
    const scheduler = new InProcessScheduler();
    let releaseExecutor!: (handle: RunHandle) => void;
    const task: ScheduledTask = {
      agent: { id: 'a' } as AgentHandle,
      input: 'x',
      executor: () =>
        new Promise<RunHandle>((resolve) => {
          releaseExecutor = resolve;
        }),
    };

    const run = await scheduler.submit(task);
    expect(run.status()).toBe('running');
    expect(scheduler.cancel(run.id, 'stop')).toBe(true);

    const real = new FakeRunHandle(run.id);
    releaseExecutor(real);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(real.cancelCalls).toBe(1);
    await expect(run.result).rejects.toThrow();
    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 1,
    });

    await scheduler.close();
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Scheduler 并发不变量（0.4 C2）', () => {
  it('settles 200 tasks without losing or duplicating counts', async () => {
    const scheduler = new InProcessScheduler({ maxConcurrency: 4, maxQueueSize: 1000 });
    const runs: RunHandle[] = [];

    for (let i = 0; i < 200; i += 1) {
      runs.push(
        await scheduler.submit({
          agent: { id: `agent-${i % 3}` } as AgentHandle,
          input: `task-${i}`,
          executor: (runId) => {
            const handle = new FakeRunHandle(runId);
            queueMicrotask(() => handle.finish('ok'));
            return Promise.resolve(handle);
          },
        }),
      );
    }

    const results = await Promise.allSettled(runs.map((run) => run.result));
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 200,
      failed: 0,
      cancelled: 0,
    });

    await scheduler.close();
  });

  it('does not double count duplicate cancels', async () => {
    const scheduler = new InProcessScheduler({ maxConcurrency: 1, maxQueueSize: 10 });
    const active = new FakeRunHandle('active');

    const first = await scheduler.submit({
      agent: { id: 'a' } as AgentHandle,
      input: 'first',
      executor: () => Promise.resolve(active),
    });
    await tick();

    const second = await scheduler.submit({
      agent: { id: 'a' } as AgentHandle,
      input: 'second',
    });
    expect(second.status()).toBe('queued');

    expect(scheduler.cancel(second.id, 'drop')).toBe(true);
    expect(scheduler.cancel(second.id, 'drop')).toBe(false);
    expect(scheduler.cancel(first.id, 'stop')).toBe(true);
    expect(scheduler.cancel(first.id, 'stop')).toBe(true);

    await expect(second.result).rejects.toThrow();
    await expect(first.result).rejects.toThrow();
    await tick();

    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 2,
    });
    expect(active.cancelCalls).toBe(2);

    await scheduler.close();
  });

  it('starts the next queued run after the running one is cancelled', async () => {
    const scheduler = new InProcessScheduler({ maxConcurrency: 1 });
    const blocking = new FakeRunHandle('blocking');
    let secondStarted = false;

    const first = await scheduler.submit({
      agent: { id: 'a' } as AgentHandle,
      input: 'first',
      executor: () => Promise.resolve(blocking),
    });
    await tick();

    const second = await scheduler.submit({
      agent: { id: 'a' } as AgentHandle,
      input: 'second',
      executor: (runId) => {
        secondStarted = true;
        const handle = new FakeRunHandle(runId);
        queueMicrotask(() => handle.finish('second'));
        return Promise.resolve(handle);
      },
    });
    expect(second.status()).toBe('queued');
    expect(secondStarted).toBe(false);

    scheduler.cancel(first.id, 'stop');
    await expect(first.result).rejects.toThrow();
    await expect(second.result).resolves.toBe('second');
    expect(secondStarted).toBe(true);

    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 1,
    });

    await scheduler.close();
  });

  it('close stops drain and cancels queued and in-flight entries', async () => {
    const scheduler = new InProcessScheduler({ maxConcurrency: 2, maxQueueSize: 100 });
    const runs: RunHandle[] = [];

    for (let i = 0; i < 10; i += 1) {
      runs.push(
        await scheduler.submit({
          agent: { id: `agent-${i % 2}` } as AgentHandle,
          input: `task-${i}`,
          executor: () => new Promise<RunHandle>(() => undefined),
        }),
      );
    }

    await scheduler.close();

    const results = await Promise.allSettled(runs.map((run) => run.result));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 10,
    });
  });

  it('keeps the queue bound while draining freed slots', async () => {
    const scheduler = new InProcessScheduler({ maxConcurrency: 1, maxQueueSize: 1 });
    const first = new FakeRunHandle('first');

    const runA = await scheduler.submit({
      agent: { id: 'a' } as AgentHandle,
      input: 'a',
      executor: () => Promise.resolve(first),
    });
    await tick();

    const runB = await scheduler.submit({
      agent: { id: 'b' } as AgentHandle,
      input: 'b',
      executor: (runId) => {
        const handle = new FakeRunHandle(runId);
        queueMicrotask(() => handle.finish('b'));
        return Promise.resolve(handle);
      },
    });

    await expect(
      scheduler.submit({
        agent: { id: 'c' } as AgentHandle,
        input: 'c',
        executor: () => Promise.resolve(new FakeRunHandle('c')),
      }),
    ).rejects.toThrow('scheduler queue is full');

    first.finish('a');
    await expect(runA.result).resolves.toBe('a');
    await expect(runB.result).resolves.toBe('b');
    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
    });

    await scheduler.close();
  });
});
