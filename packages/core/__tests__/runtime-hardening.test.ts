import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemoryRunStore } from '../src/session/run-store';
import { MemorySessionBackend } from '../src/session/session-backend';
import { GuardrailStage } from '../src/types/guardrail';
import { HookType } from '../src/types/hook';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../src/types/provider';
import type { RunCheckpoint } from '../src/types/run-store';
import { RunAlreadyRunningError } from '../src/types/run-store';
import type { ToolDefinition } from '../src/types/tool';

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

/** 工具调用一次后返回 stop */
function toolCallThenStop(toolName: string, args = '{}') {
  let calls = 0;
  return {
    chat: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls' as const,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: toolName, arguments: args },
            },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
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

async function createRuntime(opts: {
  provider: LLMProvider;
  runStore?: MemoryRunStore;
  session?: MemorySessionBackend;
  pluginHost?: MemoryPluginHost;
  events?: MemoryEventStream;
}): Promise<{ runtime: AgentRuntime; events: MemoryEventStream }> {
  const events = opts.events ?? new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider: opts.provider,
    model: 'test-model',
    context: new MemoryContextManager(),
    events,
    limits: { requestLimit: 20, toolCallsLimit: 10 },
    termination: { maxIterations: 10 },
    pluginHost: opts.pluginHost ?? new MemoryPluginHost(),
    ...(opts.runStore ? { runStore: opts.runStore } : {}),
    ...(opts.session ? { session: opts.session } : {}),
  });
  return { runtime, events };
}

describe('C1 single-run guard', () => {
  it('rejects a concurrent run with run_already_running without touching either session', async () => {
    const provider = new ControlledProvider();
    const session = new MemorySessionBackend();
    const { runtime } = await createRuntime({ provider, session });

    const started = provider.waitForRequest();
    const first = runtime.run('first', 'sess-1', { runId: 'run-1' });
    await started;

    const error = await runtime.run('second', 'sess-2', { runId: 'run-2' }).catch((e) => e);
    expect(error).toBeInstanceOf(RunAlreadyRunningError);
    expect(error.code).toBe('run_already_running');
    expect(error.runId).toBe('run-2');
    expect(error.message).toBe('run_already_running');

    // 第二个 run 没有写任何 session
    expect(await session.load('sess-2')).toBeNull();

    provider.respond('done-first');
    await expect(first).resolves.toBe('done-first');

    const firstState = await session.load('sess-1');
    expect(firstState?.status).toBe('completed');
    expect(firstState?.messages.some((m: Message) => m.content === 'second')).toBe(false);

    // finally 释放槽位：后续 run 正常
    const thirdStarted = provider.waitForRequest();
    const third = runtime.run('third', 'sess-3', { runId: 'run-3' });
    await thirdStarted;
    provider.respond('done-third');
    await expect(third).resolves.toBe('done-third');
  });

  it('also guards resume() while another run is active', async () => {
    const store = new MemoryRunStore();
    await store.save(resumeCheckpoint());
    const provider = new ControlledProvider();
    const { runtime } = await createRuntime({ provider, runStore: store });

    const started = provider.waitForRequest();
    const first = runtime.run('busy', 'sess-1', { runId: 'run-1' });
    await started;

    const error = await runtime.resume('run-resume').catch((e) => e);
    expect(error).toBeInstanceOf(RunAlreadyRunningError);
    expect(error.code).toBe('run_already_running');

    // 第一个 run 不受影响
    provider.respond('done');
    await expect(first).resolves.toBe('done');
    expect((await store.load('run-resume'))?.status).toBe('running');
  });
});

describe('C1 finalizeRun', () => {
  it('OnError hook throwing does not replace the original error and still persists terminal state', async () => {
    const host = new MemoryPluginHost();
    host.registerHook({
      name: 'bad-on-error',
      type: HookType.OnError,
      run: async () => {
        throw new Error('onerror exploded');
      },
    });
    const provider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        throw new Error('provider boom');
      },
    };
    const runStore = new MemoryRunStore();
    const session = new MemorySessionBackend();
    const { runtime, events } = await createRuntime({
      provider,
      runStore,
      session,
      pluginHost: host,
    });

    const error = await runtime.run('hi', 'sess-1', { runId: 'run-fail' }).catch((e) => e);
    // 原始错误保留，不被 hook 错误替换
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('provider boom');

    const checkpoint = await runStore.load('run-fail');
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.error).toBe('provider boom');

    const state = await session.load('sess-1');
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('provider boom');

    expect(events.getHistory().some((event) => event.type === 'hook.error')).toBe(true);
  });

  it('resume user cancel publishes run.cancelled and writes cancelled terminal state', async () => {
    const store = new MemoryRunStore();
    await store.save(resumeCheckpoint());
    const session = new MemorySessionBackend();
    const provider = new ControlledProvider();
    const { runtime, events } = await createRuntime({ provider, runStore: store, session });

    const controller = new AbortController();
    const started = provider.waitForRequest();
    const resumed = runtime.resume('run-resume', { signal: controller.signal });
    await started;
    controller.abort('user-stop');

    await expect(resumed).rejects.toThrow('user-stop');

    const types = events.getHistory().map((event) => event.type);
    expect(types).toContain('run.cancelled');
    expect(types).not.toContain('run.failed');

    expect((await store.load('run-resume'))?.status).toBe('cancelled');
    expect((await session.load('session-1'))?.status).toBe('cancelled');
  });
});

describe('C2 hook isolation', () => {
  it('a throwing BeforeLlm hook does not abort the run', async () => {
    const host = new MemoryPluginHost();
    host.registerHook({
      name: 'bad-before-llm',
      type: HookType.BeforeLlm,
      run: async () => {
        throw new Error('hook exploded');
      },
    });
    const provider = {
      chat: async () => ({ content: 'done', finish_reason: 'stop' as const }),
    };
    const { runtime, events } = await createRuntime({ provider, pluginHost: host });

    await expect(runtime.run('hi')).resolves.toBe('done');
    expect(events.getHistory().some((event) => event.type === 'hook.error')).toBe(true);
  });

  it('a throwing AfterTool hook does not abort the run', async () => {
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    host.registerHook({
      name: 'bad-after-tool',
      type: HookType.AfterTool,
      run: async () => {
        throw new Error('after tool exploded');
      },
    });
    const { runtime } = await createRuntime({
      provider: toolCallThenStop('noop'),
      pluginHost: host,
    });

    await expect(runtime.run('hi')).resolves.toBe('done');
  });
});

describe('C2 guardrail isolation', () => {
  it('a throwing ToolCall guardrail fails closed without aborting the run', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalled = true;
        return 'ok';
      },
    };
    const host = new MemoryPluginHost();
    host.registerTool(tool);
    host.registerGuardrail({
      name: 'bad-guardrail',
      stage: GuardrailStage.ToolCall,
      check: async () => {
        throw new Error('guardrail crashed');
      },
    });
    const context = new MemoryContextManager();
    const events = new MemoryEventStream();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop('noop'),
      model: 'test-model',
      pluginHost: host,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await expect(runtime.run('hi')).resolves.toBe('done');
    expect(handlerCalled).toBe(false);

    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('guardrail_error');

    const errored = events.getHistory().find((event) => event.type === 'guardrail.error');
    expect(errored?.data).toMatchObject({
      guardrail_name: 'bad-guardrail',
      error: 'guardrail crashed',
    });
  });

  it('a throwing ToolResult guardrail folds a tool error instead of failing the run', async () => {
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'secret',
    });
    host.registerGuardrail({
      name: 'bad-result-guardrail',
      stage: GuardrailStage.ToolResult,
      check: async () => {
        throw new Error('result guardrail crashed');
      },
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop('noop'),
      model: 'test-model',
      pluginHost: host,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await expect(runtime.run('hi')).resolves.toBe('done');
    expect(context.messages.find((m) => m.role === 'tool')?.content).toContain('guardrail_error');
    expect(context.messages.some((m) => m.content === 'secret')).toBe(false);
  });
});
