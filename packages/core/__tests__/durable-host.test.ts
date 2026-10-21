import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, InProcessRuntimeHost } from '../src/kernel/index';
import { MemoryLLMProvider } from '../src/provider/providers';
import { FileRunStore, MemoryRunStore } from '../src/session/run-store';
import type { ChatRequest, LLMProvider, LLMResponse } from '../src/types/provider';
import type { RunCheckpoint, RunStore } from '../src/types/run-store';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-host-runs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 记录 save 次数与快照，用于单写者断言 */
class CountingRunStore implements RunStore {
  readonly saves: RunCheckpoint[] = [];
  private readonly inner = new MemoryRunStore();

  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.saves.push(structuredClone(checkpoint));
    await this.inner.save(checkpoint);
  }

  load(runId: string): Promise<RunCheckpoint | null> {
    return this.inner.load(runId);
  }

  list(opts?: Parameters<RunStore['list']>[0]): Promise<RunCheckpoint[]> {
    return this.inner.list(opts);
  }

  delete(runId: string): Promise<void> {
    return this.inner.delete(runId);
  }
}

/** 可控 Provider：run 保持挂起，直到 respond / abort */
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
        cleanup();
        resolve(response);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(String(signal?.reason ?? 'aborted')));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        const index = this.resolvers.indexOf(resolver);
        if (index >= 0) this.resolvers.splice(index, 1);
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

/** 直接返回固定文本，用于恢复后的续跑 */
class StaticProvider implements LLMProvider {
  constructor(private readonly output: string) {}

  async chat(): Promise<LLMResponse> {
    return { content: this.output, finish_reason: 'stop' };
  }
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-resume',
    session_id: 'session-1',
    agent_id: 'worker',
    status: 'running',
    messages: [{ role: 'user', content: 'prior question' }],
    created_at: 1_000,
    updated_at: 2_000,
    iteration: 0,
    ...overrides,
  };
}

describe('InProcessRuntimeHost durable（C1）', () => {
  it('Host 注入 runStore：成员 checkpoint 带 agent_id', async () => {
    const store = new MemoryRunStore();
    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({ id: 'worker', provider: new MemoryLLMProvider(), model: 'm' });

    const run = await agent.run('hi');
    await expect(run.result).resolves.toBe('Echo: hi');

    const saved = await store.load(run.id);
    expect(saved).toMatchObject({
      run_id: run.id,
      session_id: run.sessionId,
      agent_id: 'worker',
      status: 'completed',
    });

    await host.close();
  });

  it('resume 成功：RunHandle.id 不变、sessionId 一致、结果可等待', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-ok' }));

    const host = new InProcessRuntimeHost({ runStore: store });
    await host.spawn({ id: 'worker', provider: new StaticProvider('host-resumed'), model: 'm' });

    const run = await host.resume('run-ok');
    expect(run.id).toBe('run-ok');
    expect(run.sessionId).toBe('session-1');
    expect(run.agentId).toBe('worker');
    await expect(run.result).resolves.toBe('host-resumed');
    expect((await store.load('run-ok'))?.status).toBe('completed');

    await host.close();
  });

  it('resume 错误码：未知 / 终态 / agent 不存在 / 未配置 store', async () => {
    const store = new MemoryRunStore();
    const host = new InProcessRuntimeHost({ runStore: store });
    await host.spawn({ id: 'worker', provider: new MemoryLLMProvider(), model: 'm' });

    await expect(host.resume('missing')).rejects.toMatchObject({ code: 'run_not_found' });

    await store.save(checkpoint({ run_id: 'run-done', status: 'completed' }));
    await expect(host.resume('run-done')).rejects.toMatchObject({ code: 'run_not_resumable' });

    await store.save(checkpoint({ run_id: 'run-ghost', messages: [] }));
    await expect(host.resume('run-ghost')).rejects.toMatchObject({ code: 'run_not_resumable' });

    await store.save(checkpoint({ run_id: 'run-ghost', agent_id: 'nobody' }));
    await expect(host.resume('run-ghost')).rejects.toMatchObject({ code: 'agent_not_found' });

    const bare = new InProcessRuntimeHost();
    await expect(bare.resume('run-ok')).rejects.toMatchObject({ code: 'run_store_required' });
    await bare.close();

    await host.close();
  });

  it('成员已有 active run：resume 返回 run_already_running', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-busy' }));

    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const active = await agent.run('go');
    await started;

    await expect(host.resume('run-busy')).rejects.toMatchObject({
      code: 'run_already_running',
      message: 'run_already_running: agent busy',
    });

    active.cancel('stop');
    await expect(active.result).rejects.toThrow();
    await host.close();
  });

  it('显式 cancel → checkpoint cancelled（非 interrupted）', async () => {
    const store = new MemoryRunStore();
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('go');
    await started;
    run.cancel('user-stop');
    await expect(run.result).rejects.toThrow('user-stop');

    expect((await store.load(run.id))?.status).toBe('cancelled');
    await host.close();
  });

  it('host.close 中断 → checkpoint interrupted；新 Host 可恢复（单写者）', async () => {
    const dir = await tempDir();
    const store = new CountingRunStore();
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('long');
    await started;

    const savesBeforeClose = store.saves.length;
    await host.close();
    await expect(run.result).rejects.toThrow();

    // Host 自身不写：关闭阶段只应有 runtime 的一次最终写入
    expect(store.saves.length).toBe(savesBeforeClose + 1);
    const final = store.saves.at(-1);
    expect(final?.run_id).toBe(run.id);
    expect(final?.status).toBe('interrupted');

    // 文件后端下用新 Host 实例恢复
    const fileStore = new FileRunStore({ dir });
    for (const saved of store.saves) await fileStore.save(saved);
    const host2 = new InProcessRuntimeHost({ runStore: fileStore });
    await host2.spawn({ id: 'worker', provider: new StaticProvider('recovered'), model: 'm' });
    const resumed = await host2.resume(run.id);
    await expect(resumed.result).resolves.toBe('recovered');
    expect((await fileStore.load(run.id))?.status).toBe('completed');
    await host2.close();
  });

  it('createRuntime 透传 runStore', async () => {
    const store = new MemoryRunStore();
    const host = await createRuntime({ runStore: store });
    const agent = await host.spawn({ id: 'w', provider: new MemoryLLMProvider(), model: 'm' });

    const run = await agent.run('hi');
    await run.result;
    expect((await store.load(run.id))?.status).toBe('completed');

    await host.close();
  });

  it('聚合事件流包含 run.checkpoint / run.resumed 且带 agentId', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-events' }));

    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({
      id: 'worker',
      provider: new StaticProvider('ok'),
      model: 'm',
    });

    const run = await agent.run('hi');
    await run.result;
    const resumed = await host.resume('run-events');
    await resumed.result;

    const checkpoints = host.events.getHistory().filter((event) => event.type === 'run.checkpoint');
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(
      checkpoints.every((event) => (event.data as Record<string, unknown>).agentId === 'worker'),
    ).toBe(true);

    const resumedEvents = host.events.getHistory().filter((event) => event.type === 'run.resumed');
    expect(resumedEvents.length).toBe(1);
    expect(resumedEvents[0]?.data).toMatchObject({ agentId: 'worker' });

    await host.close();
  });

  it('同一 run 并发 resume：第二个 run_already_running', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-concurrent' }));

    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost({ runStore: store });
    await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const first = await host.resume('run-concurrent');
    await expect(host.resume('run-concurrent')).rejects.toMatchObject({
      code: 'run_already_running',
      message: 'run_already_running',
    });

    await started;
    provider.respond('done-after-lock');
    await expect(first.result).resolves.toBe('done-after-lock');
    expect((await store.load('run-concurrent'))?.status).toBe('completed');

    await host.close();
  });
});

describe('resume 经 Scheduler 与取消原因（0.14.1）', () => {
  it('resume 经 Scheduler 排队：并发满时 queued，槽位释放后才执行', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-queued' }));

    const blockerProvider = new ControlledProvider();
    const host = new InProcessRuntimeHost({
      runStore: store,
      schedulerOptions: { maxConcurrency: 1 },
    });
    const blocker = await host.spawn({ id: 'blocker', provider: blockerProvider, model: 'm' });
    await host.spawn({ id: 'worker', provider: new StaticProvider('resumed-later'), model: 'm' });

    const started = blockerProvider.waitForRequest();
    const blocking = await blocker.run('hold');
    await started;

    const resumed = await host.resume('run-queued');
    expect(resumed.id).toBe('run-queued');
    expect(resumed.status()).toBe('queued');
    expect(host.scheduler.stats()).toMatchObject({ queued: 1, running: 1 });

    blockerProvider.respond('released');
    await expect(blocking.result).resolves.toBe('released');
    await expect(resumed.result).resolves.toBe('resumed-later');
    expect((await store.load('run-queued'))?.status).toBe('completed');

    await host.close();
  });

  it('排队中的 resume 被取消后释放 resuming 锁（同一 run 可再次恢复）', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ run_id: 'run-cancel-queued' }));

    const blockerProvider = new ControlledProvider();
    const host = new InProcessRuntimeHost({
      runStore: store,
      schedulerOptions: { maxConcurrency: 1 },
    });
    const blocker = await host.spawn({ id: 'blocker', provider: blockerProvider, model: 'm' });
    await host.spawn({ id: 'worker', provider: new StaticProvider('second-try'), model: 'm' });

    const started = blockerProvider.waitForRequest();
    const blocking = await blocker.run('hold');
    await started;

    const first = await host.resume('run-cancel-queued');
    expect(first.status()).toBe('queued');
    host.cancel('worker', first.id, 'user');
    await expect(first.result).rejects.toThrow();

    const second = await host.resume('run-cancel-queued');
    expect(second.status()).toBe('queued');

    blockerProvider.respond('released');
    await expect(blocking.result).resolves.toBe('released');
    await expect(second.result).resolves.toBe('second-try');

    await host.close();
  });

  it('shutdown 取消 → checkpoint interrupted；user → cancelled', async () => {
    const store = new MemoryRunStore();
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost({ runStore: store });
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('long');
    await started;
    host.cancel('worker', run.id, 'shutdown');
    await expect(run.result).rejects.toThrow();
    expect((await store.load(run.id))?.status).toBe('interrupted');

    const startedAgain = provider.waitForRequest();
    const second = await agent.run('again');
    await startedAgain;
    host.cancel('worker', second.id, 'user');
    await expect(second.result).rejects.toThrow();
    expect((await store.load(second.id))?.status).toBe('cancelled');

    await host.close();
  });
});
