import { describe, expect, it } from 'bun:test';
import type { AgentSpec, PeerInfo, Transport } from '../src/kernel/index';
import { createRuntime, InProcessScheduler, MemoryEventBus } from '../src/kernel/index';
import { MemoryLLMProvider } from '../src/provider/providers';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemorySessionBackend } from '../src/session/session-backend';
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

/** 最小 Transport（R2 只验证注入保留，不消费） */
class FakeTransport implements Transport {
  readonly kind = 'in-process' as const;

  async send(): Promise<void> {
    // no-op
  }

  receive(): () => void {
    return () => {};
  }

  async peers(): Promise<PeerInfo[]> {
    return [];
  }

  async close(): Promise<void> {
    // no-op
  }
}

describe('createRuntime（R2）', () => {
  it('默认构造：不自动 spawn owner，EventBus/Scheduler 就绪', async () => {
    const host = await createRuntime();

    expect(host.list()).toEqual([]);
    expect(host.events).toBeInstanceOf(MemoryEventBus);
    expect(host.scheduler).toBeInstanceOf(InProcessScheduler);
    expect(host.scheduler.stats()).toEqual({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });

    await host.close();
  });

  it('注入 events/session/pluginHost/transport 与 defaults', async () => {
    const events = new MemoryEventBus();
    const session = new MemorySessionBackend();
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    const transport = new FakeTransport();

    const host = await createRuntime({
      events,
      session,
      pluginHost,
      transport,
      defaults: { name: 'inherited' },
    });

    const agent = await host.spawn({
      id: 'child',
      provider: new MemoryLLMProvider(),
      model: 'm',
    });

    expect(agent.name).toBe('inherited');
    expect(agent.status().toolNames).toContain('echo');
    expect(host.events).toBe(events);
    expect((host as unknown as { transport?: Transport }).transport).toBe(transport);

    await (await agent.run('hi')).result;
    expect(await session.list()).toContain('child/default');

    await host.close();
  });

  it('scheduler 选项注入：maxConcurrency=2 可并行', async () => {
    const host = await createRuntime({ scheduler: { maxConcurrency: 2 } });
    const pa = new ControlledProvider();
    const pb = new ControlledProvider();
    const a = await host.spawn({ id: 'a', provider: pa, model: 'm' });
    const b = await host.spawn({ id: 'b', provider: pb, model: 'm' });

    const aStarted = pa.waitForRequest();
    const bStarted = pb.waitForRequest();
    const runA = await a.run('a');
    const runB = await b.run('b');

    await aStarted;
    await bStarted;
    expect(runA.status()).toBe('running');
    expect(runB.status()).toBe('running');
    expect(host.scheduler.stats().running).toBe(2);

    pa.respond('a-done');
    pb.respond('b-done');
    await expect(runA.result).resolves.toBe('a-done');
    await expect(runB.result).resolves.toBe('b-done');

    await host.close();
  });

  it('permission 注入：成员缺省走 options.permission', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'plain',
      description: 'plain',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'plain-ok';
      },
    });

    let calls = 0;
    const provider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'plain', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    };

    const host = await createRuntime({ pluginHost, permission: { default: 'ask' } });
    const agent = await host.spawn({ id: 'guarded', provider, model: 'm' });

    let requestSeen = false;
    host.events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      const data = event.data as { requestId?: string };
      if (!data.requestId) return;
      requestSeen = true;
      host.events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: data.requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    const run = await agent.run('go');
    await expect(run.result).resolves.toBe('done');
    expect(requestSeen).toBe(true);
    expect(toolRan).toBe(1);

    await host.close();
  });

  it('limits 注入：run.requestLimit 生效', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });

    const provider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'noop', arguments: '{}' },
            },
          ],
        };
      },
    };

    const host = await createRuntime({
      pluginHost,
      limits: { run: { requestLimit: 1 } },
    });
    const agent = await host.spawn({ id: 'limited', provider, model: 'm' });

    const run = await agent.run('hi');
    await expect(run.result).rejects.toThrow('Usage limits exceeded');

    await host.close();
  });

  it('defaults 可补 provider/model；id 不继承', async () => {
    const host = await createRuntime({
      defaults: {
        id: 'default-id',
        provider: new MemoryLLMProvider(),
        model: 'default-model',
      },
    });

    const agent = await host.spawn({} as AgentSpec);
    expect(agent.id).not.toBe('default-id');

    await expect((await agent.run('hi')).result).resolves.toBe('Echo: hi');

    await host.close();
  });
});
