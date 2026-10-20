import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemoryRunStore,
  MemorySessionBackend,
} from '../src/index';

/** 记录 compactAsync 调用次数，其余行为与 Memory 实现一致 */
class CountingContext extends MemoryContextManager {
  compactCalls = 0;

  override async compactAsync(): Promise<number> {
    this.compactCalls += 1;
    return await super.compactAsync();
  }
}

/** 前 N 次请求抛指定错误，之后成功；记录每次请求 */
class FailingProvider implements LLMProvider {
  readonly calls: ChatRequest[] = [];

  constructor(
    private readonly failures: number,
    private readonly message: string,
  ) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.calls.push(req);
    if (this.calls.length <= this.failures) throw new Error(this.message);
    return { content: 'recovered', finish_reason: 'stop' };
  }
}

/** 挂起直到 signal abort，用于 interrupt 测试 */
class HangingProvider implements LLMProvider {
  private resolveStarted?: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  waitForRequest(): Promise<void> {
    return this.started;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.resolveStarted?.();
    return await new Promise<LLMResponse>((_resolve, reject) => {
      const signal = req.signal;
      if (!signal) return;
      const fail = (): void => reject(new Error(String(signal.reason ?? 'aborted')));
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener('abort', fail, { once: true });
    });
  }
}

interface RuntimeParts {
  runtime: AgentRuntime;
  context: MemoryContextManager;
  events: MemoryEventStream;
}

async function createRuntime(
  provider: LLMProvider,
  options: { context?: MemoryContextManager; runStore?: MemoryRunStore } = {},
): Promise<RuntimeParts> {
  const context = options.context ?? new MemoryContextManager();
  const events = new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    context,
    events,
    limits: { requestLimit: 20, toolCallsLimit: 5 },
    termination: { maxIterations: 20 },
    session: new MemorySessionBackend(),
    ...(options.runStore !== undefined ? { runStore: options.runStore } : {}),
  });
  return { runtime, context, events };
}

const OVERFLOW_MESSAGE =
  'OpenAI API error: 400 - {"code":"context_length_exceeded","message":"maximum context length exceeded"}';

describe('context-overflow retry (0.10 R2-17)', () => {
  it('compacts once and retries once, then succeeds', async () => {
    const context = new CountingContext({ autoCompact: false });
    context.setSessionId('s');
    for (let i = 0; i < 10; i += 1) context.add({ role: 'user', content: `old-${i}` });
    const provider = new FailingProvider(1, OVERFLOW_MESSAGE);
    const { runtime } = await createRuntime(provider, { context });

    await expect(runtime.run('hi', 's')).resolves.toBe('recovered');

    expect(provider.calls).toHaveLength(2);
    expect(context.compactCalls).toBe(1);
    const firstCount = provider.calls[0]?.messages.length ?? 0;
    const secondCount = provider.calls[1]?.messages.length ?? 0;
    expect(secondCount).toBeLessThan(firstCount);
  });

  it('retries only once and rethrows the second failure unchanged', async () => {
    const context = new CountingContext({ autoCompact: false });
    context.setSessionId('s');
    for (let i = 0; i < 10; i += 1) context.add({ role: 'user', content: `old-${i}` });
    const provider = new FailingProvider(2, OVERFLOW_MESSAGE);
    const { runtime } = await createRuntime(provider, { context });

    await expect(runtime.run('hi', 's')).rejects.toThrow('context_length_exceeded');
    expect(provider.calls).toHaveLength(2);
    expect(context.compactCalls).toBe(1);
  });

  it('does not retry a 400 that is not a context overflow', async () => {
    const provider = new FailingProvider(1, 'OpenAI API error: 400 - invalid_request_error');
    const { runtime } = await createRuntime(provider);

    await expect(runtime.run('hi', 's')).rejects.toThrow('invalid_request_error');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('AgentRuntime.interrupt (0.10 R2-18)', () => {
  it('interrupt(shutdown) writes an interrupted checkpoint; no active run is a no-op', async () => {
    const store = new MemoryRunStore();
    const provider = new HangingProvider();
    const { runtime } = await createRuntime(provider, { runStore: store });

    runtime.interrupt('shutdown'); // 无 active run：no-op

    const running = runtime.run('hi', 's', { runId: 'run-shutdown' });
    await provider.waitForRequest();
    runtime.interrupt('shutdown');
    runtime.interrupt('shutdown'); // 幂等

    await expect(running).rejects.toThrow('shutdown');
    expect((await store.load('run-shutdown'))?.status).toBe('interrupted');

    runtime.interrupt('shutdown'); // run 结束后仍是 no-op
  });

  it('interrupt(user) keeps the cancelled status', async () => {
    const store = new MemoryRunStore();
    const provider = new HangingProvider();
    const { runtime } = await createRuntime(provider, { runStore: store });

    const running = runtime.run('hi', 's', { runId: 'run-user' });
    await provider.waitForRequest();
    runtime.interrupt('user');

    await expect(running).rejects.toThrow('user');
    expect((await store.load('run-user'))?.status).toBe('cancelled');
  });
});
