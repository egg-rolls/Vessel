import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemoryRunStore } from '../src/session/run-store';
import { MemorySessionBackend } from '../src/session/session-backend';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../src/types/provider';
import type { RunCheckpoint, RunStore } from '../src/types/run-store';
import { RunResumeError } from '../src/types/run-store';

/** 记录每次 save 的快照，便于断言中间 checkpoint */
class RecordingRunStore implements RunStore {
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

/** 永远写失败的 store */
class FailingRunStore implements RunStore {
  async save(): Promise<void> {
    throw new Error('disk full');
  }

  async load(): Promise<RunCheckpoint | null> {
    return null;
  }

  async list(): Promise<RunCheckpoint[]> {
    return [];
  }

  async delete(): Promise<void> {}
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

/** 记录收到的消息，用于验证 resume 恢复历史 */
class CapturingProvider implements LLMProvider {
  readonly seen: Message[][] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.seen.push(req.messages.map((message) => ({ ...message })));
    return { content: 'resumed-done', finish_reason: 'stop' };
  }
}

async function createRuntime(opts: {
  provider: LLMProvider;
  runStore?: RunStore;
  agentId?: string;
  session?: MemorySessionBackend;
  pluginHost?: MemoryPluginHost;
  events?: MemoryEventStream;
  termination?: { maxIterations: number; maxRuntimeSeconds?: number };
}): Promise<{
  runtime: AgentRuntime;
  events: MemoryEventStream;
  pluginHost: MemoryPluginHost;
}> {
  const pluginHost = opts.pluginHost ?? new MemoryPluginHost();
  const events = opts.events ?? new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider: opts.provider,
    model: 'test-model',
    context: new MemoryContextManager(),
    events,
    limits: { requestLimit: 20, toolCallsLimit: 10 },
    termination: opts.termination ?? { maxIterations: 10, maxRuntimeSeconds: 60 },
    pluginHost,
    ...(opts.runStore ? { runStore: opts.runStore } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.session ? { session: opts.session } : {}),
  });
  return { runtime, events, pluginHost };
}

function resumeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-resume',
    session_id: 'session-1',
    status: 'running',
    messages: [{ role: 'user', content: 'prior question' }],
    created_at: 1_000,
    updated_at: 2_000,
    iteration: 0,
    ...overrides,
  };
}

describe('AgentRuntime checkpoint（C1）', () => {
  it('未配置 runStore：不写 checkpoint、不发 run.checkpoint', async () => {
    const store = new MemoryRunStore();
    const { runtime, events } = await createRuntime({ provider: new MemoryLLMProvider() });

    await runtime.run('hi');

    expect(await store.list()).toEqual([]);
    expect(events.getHistory().some((event) => event.type === 'run.checkpoint')).toBe(false);
  });

  it('run 开始写 running checkpoint（含用户消息与 agent_id）', async () => {
    const store = new RecordingRunStore();
    const { runtime, events } = await createRuntime({
      provider: new MemoryLLMProvider(),
      runStore: store,
      agentId: 'agent-1',
    });

    await runtime.run('hello', 'sess-1', { runId: 'run-start' });

    const first = store.saves[0];
    expect(first).toMatchObject({
      run_id: 'run-start',
      session_id: 'sess-1',
      agent_id: 'agent-1',
      status: 'running',
      iteration: 0,
    });
    // 0.18 C2：checkpoint 不再保存完整 messages；历史由 session + 事件日志重建。
    expect(first?.messages).toEqual([]);
    // 0.18：durable 列表的 preview 来自 checkpoint metadata（不再读 messages）
    expect(store.saves.at(-1)?.metadata?.preview).toBe('hello');
    expect(store.saves.at(-1)?.status).toBe('completed');

    const checkpointEvents = events.getHistory().filter((event) => event.type === 'run.checkpoint');
    expect(checkpointEvents.length).toBe(store.saves.length);
    for (const event of checkpointEvents) {
      expect((event.data as Record<string, unknown>).messages).toBeUndefined();
    }
  });

  it('每完成一轮 tool-call 写 checkpoint：iteration 递增且消息配对', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'tool-result',
    });

    let calls = 0;
    const provider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }
        return {
          content: 'done',
          finish_reason: 'stop',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
      },
    };

    const store = new RecordingRunStore();
    const { runtime } = await createRuntime({ provider, runStore: store, pluginHost });

    await expect(runtime.run('go', undefined, { runId: 'run-tool' })).resolves.toBe('done');

    const toolRound = store.saves.find(
      (checkpoint) => checkpoint.status === 'running' && checkpoint.iteration === 1,
    );
    expect(toolRound).toBeDefined();
    // 0.18 C2：工具轮进度只写 iteration / event_cursor，不再复制历史。
    expect(toolRound?.messages).toEqual([]);
    expect(toolRound?.iteration).toBe(1);

    const final = store.saves.at(-1);
    expect(final?.status).toBe('completed');
    expect(final?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      total_cost: 0,
    });
  });

  it('Provider 抛错：最终 checkpoint failed 且保留 error', async () => {
    const store = new RecordingRunStore();
    const provider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        throw new Error('boom');
      },
    };
    const { runtime } = await createRuntime({ provider, runStore: store });

    await expect(runtime.run('hi', undefined, { runId: 'run-fail' })).rejects.toThrow('boom');

    const final = await store.load('run-fail');
    expect(final?.status).toBe('failed');
    expect(final?.error).toContain('boom');
  });

  it('AbortSignal：用户取消写 cancelled，Host 关闭 reason 写 interrupted', async () => {
    const store = new MemoryRunStore();
    const provider = new ControlledProvider();
    const { runtime } = await createRuntime({ provider, runStore: store });

    const firstController = new AbortController();
    const firstStarted = provider.waitForRequest();
    const first = runtime.run('hi', undefined, {
      runId: 'run-cancel',
      signal: firstController.signal,
    });
    await firstStarted;
    firstController.abort('user-stop');
    await expect(first).rejects.toThrow('user-stop');
    expect((await store.load('run-cancel'))?.status).toBe('cancelled');

    const secondController = new AbortController();
    const secondStarted = provider.waitForRequest();
    const second = runtime.run('hi', undefined, {
      runId: 'run-interrupt',
      signal: secondController.signal,
    });
    await secondStarted;
    secondController.abort('agent closed');
    await expect(second).rejects.toThrow('agent closed');
    expect((await store.load('run-interrupt'))?.status).toBe('interrupted');
  });

  it('checkpoint 写失败：run 以 run_checkpoint_failed 失败', async () => {
    const { runtime, events } = await createRuntime({
      provider: new MemoryLLMProvider(),
      runStore: new FailingRunStore(),
    });

    await expect(runtime.run('hi', undefined, { runId: 'run-disk' })).rejects.toThrow(
      'run_checkpoint_failed',
    );
    expect(events.getHistory().some((event) => event.type === 'run.failed')).toBe(true);
  });
});

describe('AgentRuntime.resume（C1）', () => {
  it('未知 id / 终态 / 空 messages / 未配置 store 返回稳定错误', async () => {
    const store = new MemoryRunStore();
    const { runtime } = await createRuntime({ provider: new MemoryLLMProvider(), runStore: store });

    await expect(runtime.resume('missing')).rejects.toMatchObject({
      code: 'run_not_found',
      runId: 'missing',
    });

    await store.save(resumeCheckpoint({ status: 'completed' }));
    await expect(runtime.resume('run-resume')).rejects.toMatchObject({
      code: 'run_not_resumable',
    });

    await store.save(resumeCheckpoint({ messages: [] }));
    await expect(runtime.resume('run-resume')).rejects.toMatchObject({
      code: 'run_not_resumable',
      message: 'run_not_resumable: empty checkpoint',
    });

    const { runtime: noStore } = await createRuntime({ provider: new MemoryLLMProvider() });
    const error = await noStore.resume('run-resume').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunResumeError);
    expect((error as RunResumeError).code).toBe('run_store_required');
  });

  it('resume running：恢复历史、返回最终文本、run_id 不变、发 run.resumed', async () => {
    const store = new MemoryRunStore();
    const session = new MemorySessionBackend();
    await store.save(
      resumeCheckpoint({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'prior question' },
          { role: 'assistant', content: 'prior answer' },
        ],
        iteration: 2,
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }),
    );

    const provider = new CapturingProvider();
    const { runtime, events } = await createRuntime({ provider, runStore: store, session });

    await expect(runtime.resume('run-resume')).resolves.toBe('resumed-done');

    expect(provider.seen[0]?.map((message) => message.content)).toEqual([
      'sys',
      'prior question',
      'prior answer',
    ]);
    expect(events.getHistory().some((event) => event.type === 'run.resumed')).toBe(true);

    const final = await store.load('run-resume');
    expect(final?.status).toBe('completed');
    expect(final?.run_id).toBe('run-resume');
    expect(final?.session_id).toBe('session-1');
    expect(final?.iteration).toBe(3);
    // 0.18 C2：历史在 session 缓存（投影）中，不在 checkpoint。
    expect(final?.messages).toEqual([]);
    const savedSession = await session.load('session-1');
    expect(savedSession?.status).toBe('completed');
    expect(savedSession?.messages.some((message) => message.content === 'resumed-done')).toBe(true);
  });

  it('resume interrupted 也可恢复；iteration 连续触发 termination', async () => {
    const store = new MemoryRunStore();
    await store.save(resumeCheckpoint({ status: 'interrupted', iteration: 4 }));
    const { runtime } = await createRuntime({
      provider: new CapturingProvider(),
      runStore: store,
      termination: { maxIterations: 4 },
    });

    await expect(runtime.resume('run-resume')).rejects.toThrow('Termination policy triggered');
  });

  it('同一 run 并发 resume：第二个立即 run_already_running，结束后锁释放', async () => {
    const store = new MemoryRunStore();
    await store.save(resumeCheckpoint());
    const provider = new ControlledProvider();
    const { runtime } = await createRuntime({ provider, runStore: store });

    const started = provider.waitForRequest();
    const first = runtime.resume('run-resume');
    await expect(runtime.resume('run-resume')).rejects.toMatchObject({
      code: 'run_already_running',
      runId: 'run-resume',
    });

    await started;
    provider.respond('done-after-lock');
    await expect(first).resolves.toBe('done-after-lock');
    expect((await store.load('run-resume'))?.status).toBe('completed');
  });

  it('resume 完成后再次 resume → run_not_resumable', async () => {
    const store = new MemoryRunStore();
    await store.save(resumeCheckpoint());
    const provider = new CapturingProvider();
    const { runtime } = await createRuntime({ provider, runStore: store });

    await runtime.resume('run-resume');
    await expect(runtime.resume('run-resume')).rejects.toMatchObject({
      code: 'run_not_resumable',
    });
  });
});
