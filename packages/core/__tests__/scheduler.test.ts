import { describe, expect, it } from 'bun:test';
import { InProcessRuntimeHost } from '../src/kernel/index';
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
