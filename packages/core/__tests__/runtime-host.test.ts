import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import type { AgentMessage, EventBus, RunnableAgent } from '../src/kernel/index';
import { createCancellationScope, InProcessRuntimeHost, MemoryEventBus } from '../src/kernel/index';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemorySessionBackend } from '../src/session/session-backend';
import type { RunEvent } from '../src/types/event';
import type { ChatRequest, LLMProvider, LLMResponse, Message, Usage } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

/** 可控 Provider：run 保持挂起，直到测试调用 respond / 取消 */
class ControlledProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];
  private readonly resolvers: Array<(response: LLMResponse) => void> = [];
  private readonly starters: Array<() => void> = [];

  waitForRequest(): Promise<void> {
    return new Promise((resolve) => {
      this.starters.push(resolve);
    });
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    this.starters.shift()?.();

    return await new Promise<LLMResponse>((resolve, reject) => {
      const signal = req.signal;
      const resolver = (response: LLMResponse) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };
      const onAbort = () => {
        // 取消时移除挂起的 resolver，避免后续 respond 命中已拒绝的调用
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

  respond(content = 'done', usage?: Usage): void {
    const response: LLMResponse = { content, finish_reason: 'stop' };
    if (usage) response.usage = usage;
    this.resolvers.shift()?.(response);
  }
}

/** 记录每次请求 messages 的 Provider（用于 context 隔离测试） */
class RecordingProvider implements LLMProvider {
  readonly seen: Message[][] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.seen.push(req.messages);
    return { content: `ok:${req.model}`, finish_reason: 'stop' };
  }
}

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'to'>): AgentMessage {
  return {
    id: randomUUID(),
    from: 'owner',
    kind: 'message',
    content: 'hello',
    ts: Date.now(),
    ...overrides,
  };
}

describe('CancellationScope（A2）', () => {
  it('父取消自动中止所有子作用域', () => {
    const root = createCancellationScope();
    const child = root.child();
    const grandchild = child.child();

    expect(child.cancelled).toBe(false);
    root.cancel('root-cancelled');

    expect(root.cancelled).toBe(true);
    expect(child.cancelled).toBe(true);
    expect(grandchild.cancelled).toBe(true);
    expect(child.signal.reason).toBe('root-cancelled');
    expect(grandchild.signal.reason).toBe('root-cancelled');
  });

  it('子取消不影响父；已取消的父创建子立即中止', () => {
    const root = createCancellationScope();
    const child = root.child();

    child.cancel('child');
    expect(child.cancelled).toBe(true);
    expect(root.cancelled).toBe(false);

    root.cancel('root');
    expect(root.child().cancelled).toBe(true);
  });

  it('传入已中止的父 signal 时立即中止', () => {
    const controller = new AbortController();
    controller.abort('parent');
    const scope = createCancellationScope(controller.signal);
    expect(scope.cancelled).toBe(true);
    expect(scope.signal.reason).toBe('parent');
  });
});

describe('InProcessRuntimeHost 生命周期', () => {
  it('spawn/get/list 与成员工具快照', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    const host = new InProcessRuntimeHost({ pluginHost });
    const provider = new MemoryLLMProvider();

    const alpha = await host.spawn({ id: 'alpha', name: 'Alpha', provider, model: 'm' });
    const beta = await host.spawn({ id: 'beta', provider, model: 'm' });

    expect(host.get('alpha')).toBe(alpha);
    expect(host.get('beta')).toBe(beta);
    expect(host.get('missing')).toBeUndefined();

    const statuses = host.list();
    expect(statuses.map((status) => status.id).sort()).toEqual(['alpha', 'beta']);
    expect(statuses.find((status) => status.id === 'alpha')?.name).toBe('Alpha');
    expect(statuses.find((status) => status.id === 'beta')?.toolNames).toContain('echo');

    await host.close();
    expect(host.get('alpha')).toBeUndefined();
    expect(host.list()).toEqual([]);
  });

  it('成员上限与非法 id（A11）', async () => {
    const host = new InProcessRuntimeHost({ maxMembers: 1 });
    const provider = new MemoryLLMProvider();
    await host.spawn({ id: 'a', provider, model: 'm' });

    await expect(host.spawn({ id: 'b', provider, model: 'm' })).rejects.toThrow(
      'agent limit reached',
    );

    for (const id of ['', 'bad id', 'bad/id', 'bad:id', 'a'.repeat(65)]) {
      await expect(host.spawn({ id, provider, model: 'm' })).rejects.toThrow('invalid agent id');
    }

    await host.close();

    const second = new InProcessRuntimeHost();
    await expect(second.spawn({ id: 'ok_id-1', provider, model: 'm' })).resolves.toBeDefined();
    await second.close();
  });

  it('成员 context 独占：历史不串成员', async () => {
    const provider = new RecordingProvider();
    const host = new InProcessRuntimeHost();
    const a = await host.spawn({ id: 'a', provider, model: 'model-a' });
    const b = await host.spawn({ id: 'b', provider, model: 'model-b' });

    await (await a.run('hello-a')).result;
    await (await b.run('hello-b')).result;
    await (await a.run('again-a')).result;

    const [firstA, firstB, secondA] = provider.seen;
    const textA1 = JSON.stringify(firstA);
    const textB = JSON.stringify(firstB);
    const textA2 = JSON.stringify(secondA);

    expect(textA1).toContain('hello-a');
    expect(textA1).not.toContain('hello-b');
    expect(textB).toContain('hello-b');
    expect(textB).not.toContain('hello-a');
    expect(textA2).toContain('hello-a');
    expect(textA2).toContain('again-a');
    expect(textA2).not.toContain('hello-b');

    await host.close();
  });

  it('RunHandle.status 随生命周期变化（A1）', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('hello');

    expect(typeof run.status).toBe('function');
    expect(run.status()).toBe('running');
    expect(agent.status().state).toBe('running');
    expect(agent.status().currentRunId).toBe(run.id);

    await started;
    provider.respond('done');

    await expect(run.result).resolves.toBe('done');
    expect(run.status()).toBe('completed');
    expect(agent.status().state).toBe('idle');
    expect(agent.status().currentRunId).toBeUndefined();

    await host.close();
  });

  it('RunHandle.id 与成员事件流 run_id 一致（F6）', async () => {
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({
      id: 'aligned',
      provider: new MemoryLLMProvider(),
      model: 'm',
    });

    const run = await agent.run('hi');
    await run.result;

    const started = host.events
      .getHistory()
      .find(
        (event) =>
          event.type === 'run.started' &&
          (event.data as { agentId?: string }).agentId === 'aligned',
      );
    expect(started?.run_id).toBe(run.id);

    await host.close();
  });

  it('RunHandle.usage 返回本次 run 用量（A9）', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'usage', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('hello');
    expect(run.usage()).toBeUndefined();

    await started;
    provider.respond('done', { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    await run.result;

    expect(run.usage()).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });

    await host.close();
  });

  it('同一成员 R1 同时只允许一个 run', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('first');
    await started;

    await expect(agent.run('second')).rejects.toThrow('already has a running run');

    provider.respond('first-done');
    await expect(run.result).resolves.toBe('first-done');

    await host.close();
  });
});

describe('消息与收件箱', () => {
  it('send/inbox：成员投递、广播、游标分页', async () => {
    const host = new InProcessRuntimeHost();
    const provider = new MemoryLLMProvider();
    const a = await host.spawn({ id: 'a', provider, model: 'm' });
    const b = await host.spawn({ id: 'b', provider, model: 'm' });

    await host.send(message({ id: 'm1', to: 'a', content: 'one' }));
    await host.send(message({ id: 'm2', to: '*', content: 'all' }));
    await a.send(message({ id: 'm3', from: 'a', to: 'b', content: 'direct' }));

    const pageA = await a.inbox();
    expect(pageA.messages.map((item) => item.id)).toEqual(['m1', 'm2']);
    // 游标是不透明字符串；原样回传即可
    expect((await a.inbox(pageA.cursor)).messages).toEqual([]);

    const pageB = await b.inbox();
    expect(pageB.messages.map((item) => item.id).sort()).toEqual(['m2', 'm3']);

    await host.close();
  });

  it('非成员邮箱：send 按需建箱，inbox 可读（Q2）', async () => {
    const host = new InProcessRuntimeHost();
    const a = await host.spawn({
      id: 'a',
      provider: new MemoryLLMProvider(),
      model: 'm',
    });

    await host.send(message({ id: 'own-1', from: 'a', to: 'owner', content: 'result' }));
    const owner = await host.inbox('owner');
    expect(owner.messages.map((item) => item.id)).toEqual(['own-1']);

    // 未知 mailbox 读取返回空页，不抛错
    expect((await host.inbox('nobody')).messages).toEqual([]);

    // 成员收件箱不受影响
    expect((await a.inbox()).messages).toEqual([]);

    await host.close();
  });
});

describe('取消与关闭', () => {
  it('RunHandle.cancel 中止当前 run；成员可再次运行', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('first');
    await started;

    run.cancel('stop-now');
    await expect(run.result).rejects.toThrow();
    expect(run.status()).toBe('cancelled');
    expect(agent.status().state).toBe('cancelled');

    const startedAgain = provider.waitForRequest();
    const second = await agent.run('second');
    await startedAgain;
    provider.respond('second-done');
    await expect(second.result).resolves.toBe('second-done');
    expect(agent.status().state).toBe('idle');

    await host.close();
  });

  it('Host.cancel 也可中止成员当前 run', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('first');
    await started;

    host.cancel('worker', run.id);
    await expect(run.result).rejects.toThrow();
    expect(run.status()).toBe('cancelled');

    await host.close();
  });

  it('close 中止运行中的 run 并清理成员', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await agent.run('long');
    await started;

    await host.close();

    await expect(run.result).rejects.toThrow();
    expect(host.get('worker')).toBeUndefined();
    expect(host.list()).toEqual([]);
    expect(agent.status().state).toBe('closed');
    expect(host.events.getHistory().some((event) => event.type === 'agent.closed')).toBe(true);
  });
});

describe('Session 命名空间（D3）', () => {
  it('共享后端按 agentId 隔离 session', async () => {
    const backend = new MemorySessionBackend();
    const host = new InProcessRuntimeHost({ session: backend });
    const provider = new MemoryLLMProvider();
    const a = await host.spawn({ id: 'a', provider, model: 'm' });
    const b = await host.spawn({ id: 'b', provider, model: 'm' });

    await (await a.run('hello-a')).result;
    await (await b.run('hello-b')).result;

    expect((await backend.list()).sort()).toEqual(['a/default', 'b/default']);
    const loadedA = await backend.load('a/default');
    const loadedB = await backend.load('b/default');
    expect(JSON.stringify(loadedA?.messages)).toContain('hello-a');
    expect(JSON.stringify(loadedA?.messages)).not.toContain('hello-b');
    expect(JSON.stringify(loadedB?.messages)).toContain('hello-b');

    await host.close();
  });
});

describe('事件聚合（D4/A7）', () => {
  it('聚合事件带 agentId，subscribeFiltered 可按成员过滤', async () => {
    const events = new MemoryEventBus();
    const host = new InProcessRuntimeHost({ events });
    const provider = new MemoryLLMProvider();
    const a = await host.spawn({ id: 'a', provider, model: 'm' });
    const b = await host.spawn({ id: 'b', provider, model: 'm' });

    const filtered: RunEvent[] = [];
    events.subscribeFiltered(
      (event) => {
        filtered.push(event);
      },
      { agentId: 'a' },
    );

    await (await a.run('hello')).result;
    await (await b.run('world')).result;

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((event) => (event.data as { agentId?: string }).agentId === 'a')).toBe(
      true,
    );

    const all = events.getHistory();
    expect(all.some((event) => event.type === 'agent.spawned')).toBe(true);
    expect(
      all.some(
        (event) =>
          event.type === 'run.started' && (event.data as { agentId?: string }).agentId === 'a',
      ),
    ).toBe(true);
    expect(
      all.some(
        (event) =>
          event.type === 'agent.run.completed' &&
          (event.data as { agentId?: string }).agentId === 'a',
      ),
    ).toBe(true);

    await host.close();
  });

  it('注入自定义 EventBus 时 Host 复用它', async () => {
    const events: EventBus = new MemoryEventBus();
    const host = new InProcessRuntimeHost({ events });
    expect(host.events).toBe(events);
    await host.close();
  });
});

describe('子成员交互请求（B4）', () => {
  it('子 tool.permission.request 可达 Host 聚合流，owner 应答可回灌', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    const guardedTool: ToolDefinition = {
      name: 'guarded',
      description: 'guarded',
      inputSchema: { type: 'object', properties: {} },
      checkPermission: async () => 'ask',
      handler: async () => {
        toolRan++;
        return 'guarded-ok';
      },
    };
    pluginHost.registerTool(guardedTool);

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
                id: 'call-1',
                type: 'function',
                function: { name: 'guarded', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    };

    const host = new InProcessRuntimeHost({ pluginHost });
    const agent = await host.spawn({ id: 'guarded-agent', provider, model: 'm' });

    let requestSeen: { requestId: string; agentId?: string } | undefined;
    const responded = new Promise<void>((resolve) => {
      host.events.subscribe((event) => {
        if (event.type !== 'tool.permission.request') return;
        const data = event.data as { requestId?: string; agentId?: string };
        if (!data.requestId || requestSeen) return;
        requestSeen = { requestId: data.requestId, agentId: data.agentId };
        host.events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId: data.requestId, decision: 'allow' },
          ts: Date.now(),
        });
        resolve();
      });
    });

    const run = await agent.run('go');
    await expect(run.result).resolves.toBe('done');
    await responded;
    expect(requestSeen?.agentId).toBe('guarded-agent');
    expect(toolRan).toBe(1);

    await host.close();
  });
});

describe('RunnableAgent（A10）', () => {
  it('AgentRuntime 结构上满足 RunnableAgent', async () => {
    const runtime = await AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'm',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {},
      termination: { maxIterations: 1 },
    });

    const runnable: RunnableAgent = runtime;
    expect(runnable.events).toBe(runtime.events);
    expect(runnable.pluginHost).toBe(runtime.pluginHost);
    expect(typeof runnable.run).toBe('function');
    expect(typeof runnable.dispose).toBe('function');

    runtime.dispose();
  });
});

describe('Scheduler（F2）', () => {
  it('submit/cancel/stats/close 的 R1 受限行为', async () => {
    const provider = new ControlledProvider();
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({ id: 'worker', provider, model: 'm' });

    const started = provider.waitForRequest();
    const run = await host.scheduler.submit({ agent, input: 'first' });
    await started;

    expect(host.scheduler.stats().queued).toBe(0);
    expect(host.scheduler.stats().running).toBe(1);
    await expect(host.scheduler.submit({ agent, input: 'second' })).rejects.toThrow(
      'already has a running run',
    );

    expect(host.scheduler.cancel(run.id, 'stop')).toBe(true);
    await expect(run.result).rejects.toThrow();
    await Promise.resolve();

    expect(host.scheduler.stats().running).toBe(0);
    expect(host.scheduler.stats().cancelled).toBe(1);

    await host.scheduler.close();
    await host.close();
  });

  it('完成的 run 计入 completed', async () => {
    const host = new InProcessRuntimeHost();
    const agent = await host.spawn({
      id: 'worker',
      provider: new MemoryLLMProvider(),
      model: 'm',
    });

    const run = await host.scheduler.submit({ agent, input: 'hi' });
    await run.result;
    await Promise.resolve();

    expect(host.scheduler.stats().completed).toBe(1);

    await host.close();
  });
});

describe('限额与默认实现覆盖（F3/F5）', () => {
  it('limits.run.requestLimit 生效', async () => {
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

    const host = new InProcessRuntimeHost({ pluginHost });
    const agent = await host.spawn({
      id: 'limited',
      provider,
      model: 'm',
      limits: { run: { requestLimit: 1 } },
    });

    const run = await agent.run('hi');
    await expect(run.result).rejects.toThrow('Usage limits exceeded');
    expect(run.status()).toBe('failed');

    await host.close();
  });

  it('runtimeFactory / eventStreamFactory 可替换默认实现', async () => {
    let runtimeCreated = 0;
    let streamsCreated = 0;

    const host = new InProcessRuntimeHost({
      runtimeFactory: async (options) => {
        runtimeCreated++;
        return AgentRuntime.create(options);
      },
      eventStreamFactory: () => {
        streamsCreated++;
        return new MemoryEventStream();
      },
    });

    await host.spawn({ id: 'a', provider: new MemoryLLMProvider(), model: 'm' });

    expect(runtimeCreated).toBe(1);
    expect(streamsCreated).toBe(1);

    await host.close();
  });
});

describe('上下文工厂', () => {
  it('未能注入 context 时使用 contextFactory', async () => {
    let created = 0;
    const host = new InProcessRuntimeHost({
      contextFactory: () => {
        created++;
        return new MemoryContextManager();
      },
    });
    await host.spawn({ id: 'a', provider: new MemoryLLMProvider(), model: 'm' });
    expect(created).toBe(1);
    await host.close();
  });
});
