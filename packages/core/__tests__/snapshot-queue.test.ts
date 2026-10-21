import { describe, expect, it } from 'bun:test';
import {
  type ChatRequest,
  InProcessRuntimeHost,
  InProcessTransport,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  type RunEvent,
} from '../src/index';

/** 可控 Provider：保持挂起，直到测试 respond */
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

function queueEvents(events: RunEvent[]): RunEvent[] {
  return events.filter(
    (event) => event.type === 'agent.queue.entered' || event.type === 'agent.queue.left',
  );
}

describe('agent.queue.* (0.15 E4)', () => {
  it('publishes entered/left with position and per-agent-serial wait reason', async () => {
    const host = new InProcessRuntimeHost({ schedulerOptions: { maxConcurrency: 2 } });
    const provider = new ControlledProvider();
    const agent = await host.spawn({ id: 'a', provider, model: 'm' });
    const seen: RunEvent[] = [];
    host.events.subscribe((event) => {
      if (queueEvents([event]).length > 0) seen.push(event);
    });

    const firstStarted = provider.waitForRequest();
    const first = await agent.run('first');
    await firstStarted;

    const second = await agent.run('second');
    expect(second.status()).toBe('queued');

    const entered = seen.filter((event) => event.type === 'agent.queue.entered');
    expect(entered).toHaveLength(1);
    expect(entered[0]?.data).toMatchObject({
      agent_id: 'a',
      run_id: second.id,
      position: 1,
      wait_reason: 'per_agent_serial',
    });
    const enteredData = entered[0]?.data as Record<string, unknown> | undefined;
    expect(typeof enteredData?.since).toBe('number');

    const snapshot = host.snapshot();
    expect(snapshot.scheduler.queued[0]?.waitReason).toBe('per_agent_serial');
    const member = snapshot.agents.find((entry) => entry.id === 'a');
    expect(member?.queuePosition).toBe(1);
    expect(member?.waitReason).toBe('per_agent_serial');

    const secondStarted = provider.waitForRequest();
    provider.respond('first-done');
    await expect(first.result).resolves.toBe('first-done');
    await secondStarted;

    const left = seen.filter((event) => event.type === 'agent.queue.left');
    expect(left).toHaveLength(1);
    expect(left[0]?.data).toMatchObject({
      agent_id: 'a',
      run_id: second.id,
      position: 1,
      wait_reason: 'per_agent_serial',
    });

    provider.respond('second-done');
    await expect(second.result).resolves.toBe('second-done');
    await host.close();
  });
});

describe('snapshot additive fields (0.15 E3)', () => {
  it('fills node/task/context/last_seen and reports capacity wait reason', async () => {
    const transport = new InProcessTransport({ nodeId: 'node-1' });
    const host = new InProcessRuntimeHost({
      transport,
      schedulerOptions: { maxConcurrency: 1 },
      contextFactory: () => new MemoryContextManager({ maxTokens: 1000 }),
    });
    const providerA = new ControlledProvider();
    const providerB = new ControlledProvider();
    const agentA = await host.spawn({ id: 'a', provider: providerA, model: 'm' });
    const agentB = await host.spawn({
      id: 'b',
      provider: providerB,
      model: 'm',
      metadata: { task: { id: 't1', title: 'demo' } },
    });

    const aStarted = providerA.waitForRequest();
    const runA = await agentA.run('a');
    await aStarted;
    const runB = await agentB.run('b');
    expect(runB.status()).toBe('queued');

    const snapshot = host.snapshot();
    const snapA = snapshot.agents.find((entry) => entry.id === 'a');
    const snapB = snapshot.agents.find((entry) => entry.id === 'b');

    expect(snapA?.state).toBe('running');
    expect(snapA?.nodeId).toBe('node-1');
    expect(snapA?.contextMax).toBe(1000);
    expect(snapA?.contextUsed).toBeGreaterThan(0);
    expect(typeof snapA?.lastSeen).toBe('number');
    expect(snapA?.waitReason).toBeUndefined();
    expect(snapA?.childrenCount).toBeUndefined();

    // AgentState 没有 queued；排队由 queuePosition / waitReason 表达
    expect(snapB?.state).toBe('idle');
    expect(snapB?.queuePosition).toBe(1);
    expect(snapB?.waitReason).toBe('capacity');
    expect(snapB?.task).toEqual({ id: 't1', title: 'demo' });
    expect(snapB?.contextMax).toBe(1000);
    expect(snapB?.contextUsed).toBe(0);
    expect(snapshot.scheduler.queued[0]?.waitReason).toBe('capacity');

    const bStarted = providerB.waitForRequest();
    providerA.respond('a-done');
    await expect(runA.result).resolves.toBe('a-done');
    await bStarted;
    providerB.respond('b-done');
    await expect(runB.result).resolves.toBe('b-done');
    await host.close();
  });
});
