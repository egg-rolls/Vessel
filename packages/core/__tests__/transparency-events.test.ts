import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type RunEvent,
} from '../src/index';

/** 前 N 次请求抛 context-overflow，之后成功 */
class OverflowProvider implements LLMProvider {
  calls = 0;

  async chat(): Promise<LLMResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new Error(
        'OpenAI API error: 400 - {"code":"context_length_exceeded","message":"maximum context length exceeded"}',
      );
    }
    return { content: 'recovered', finish_reason: 'stop' };
  }
}

/** 每次请求都返回 tool_calls（用 requestLimit / maxIterations 收口） */
class ToolLoopProvider implements LLMProvider {
  calls = 0;

  async chat(): Promise<LLMResponse> {
    this.calls += 1;
    return {
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: `call-${this.calls}`,
          type: 'function',
          function: { name: 'noop', arguments: '{}' },
        },
      ],
    };
  }
}

/** 第一次返回 tool_calls，之后 stop */
class OneToolCallProvider implements LLMProvider {
  calls = 0;

  async chat(): Promise<LLMResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      };
    }
    return { content: 'done', finish_reason: 'stop' };
  }
}

function noopHost(): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name: 'noop',
    description: 'noop',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
  return host;
}

function subscribeCompacted(events: MemoryEventStream): RunEvent[] {
  return subscribeCompactedWithLength(events).events;
}

/** 事件发布时刻的 context.messages.length，用于核对 `remaining` 不是事后值 */
function subscribeCompactedWithLength(
  events: MemoryEventStream,
  context?: MemoryContextManager,
): { events: RunEvent[]; remainingAtEvent: number[] } {
  const result: RunEvent[] = [];
  const remainingAtEvent: number[] = [];
  events.subscribe((event) => {
    if (event.type !== 'context.compacted') return;
    result.push(event);
    if (context) remainingAtEvent.push(context.messages.length);
  });
  return { events: result, remainingAtEvent };
}

/** 已有 12 条非 system 消息，超过 maxTokens × 0.8；summarizer 让 add() 延迟到 autoCompactAsync */
function compactableContext(): MemoryContextManager {
  const context = new MemoryContextManager({
    maxTokens: 100,
    autoCompact: true,
    compactThreshold: 0.8,
    summarizer: async () => 'summary',
  });
  context.setSessionId('s');
  for (let i = 0; i < 12; i += 1) {
    context.add({ role: 'user', content: 'x'.repeat(40) });
  }
  return context;
}

function createRuntime(options: {
  provider: LLMProvider;
  context: MemoryContextManager;
  events: MemoryEventStream;
  pluginHost?: MemoryPluginHost;
  limits?: { requestLimit?: number; toolCallsLimit?: number };
  maxIterations?: number;
}): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider: options.provider,
    model: 'test-model',
    context: options.context,
    events: options.events,
    pluginHost: options.pluginHost ?? new MemoryPluginHost(),
    session: new MemorySessionBackend(),
    limits: options.limits ?? {},
    termination: { maxIterations: options.maxIterations ?? 20 },
  });
}

describe('context.compacted (0.15 E1)', () => {
  it('publishes one event with reason auto when auto compaction removes messages', async () => {
    const context = compactableContext();
    const events = new MemoryEventStream();
    const { events: compacted, remainingAtEvent } = subscribeCompactedWithLength(events, context);
    const runtime = await createRuntime({
      provider: { chat: async () => ({ content: 'ok', finish_reason: 'stop' }) },
      context,
      events,
    });

    await runtime.run('hi', 's');

    expect(compacted).toHaveLength(1);
    const data = compacted[0]?.data as Record<string, unknown>;
    expect(data.reason).toBe('auto');
    expect(data.removed).toBeGreaterThan(0);
    expect(data.remaining).toBe(remainingAtEvent[0]);
    expect(data.run_id).toBe(compacted[0]?.run_id);
    expect(data.session_id).toBe('s');
  });

  it('publishes reason manual when a harness calls compactContext', async () => {
    const context = compactableContext();
    const events = new MemoryEventStream();
    const compacted = subscribeCompacted(events);
    const runtime = await createRuntime({
      provider: { chat: async () => ({ content: 'ok', finish_reason: 'stop' }) },
      context,
      events,
    });

    const removed = await runtime.compactContext();

    expect(removed).toBeGreaterThan(0);
    expect(compacted).toHaveLength(1);
    const data = compacted[0]?.data as Record<string, unknown>;
    expect(data.reason).toBe('manual');
    expect(data.run_id).toBe('manual');
    expect(data.remaining).toBe(context.messages.length);
  });

  it('publishes reason overflow when a 400 context-overflow forces a retry compaction', async () => {
    const context = new MemoryContextManager({ autoCompact: false });
    context.setSessionId('s');
    for (let i = 0; i < 10; i += 1) context.add({ role: 'user', content: `old-${i}` });
    const events = new MemoryEventStream();
    const compacted = subscribeCompacted(events);
    const provider = new OverflowProvider();
    const runtime = await createRuntime({ provider, context, events });

    await expect(runtime.run('hi', 's')).resolves.toBe('recovered');

    expect(compacted).toHaveLength(1);
    const data = compacted[0]?.data as Record<string, unknown>;
    expect(data.reason).toBe('overflow');
    expect(data.removed).toBeGreaterThan(0);
    expect(provider.calls).toBe(2);
  });
});

describe('agent.limit.warning (0.15 E2)', () => {
  it('publishes once per key at 80% and not again at 100%', async () => {
    const events = new MemoryEventStream();
    const warnings: RunEvent[] = [];
    const blocked: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'agent.limit.warning') warnings.push(event);
      if (event.type === 'limit.blocked') blocked.push(event);
    });
    const runtime = await createRuntime({
      provider: new ToolLoopProvider(),
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      pluginHost: noopHost(),
      limits: { requestLimit: 10, toolCallsLimit: 1000 },
      maxIterations: 50,
    });

    await expect(runtime.run('go')).rejects.toThrow('Usage limits exceeded');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toEqual({
      scope: 'run',
      key: 'request_limit',
      current: 8,
      max: 10,
      source: 'limits.requestLimit',
      threshold: 0.8,
      hint: expect.any(String),
    });
    expect(blocked).toHaveLength(1);
    const blockedData = blocked[0]?.data as Record<string, unknown> | undefined;
    expect(blockedData?.key).toBe('request_limit');
  });

  it('does not warn when the hard limit is reached without crossing 80%', async () => {
    const events = new MemoryEventStream();
    const warnings: RunEvent[] = [];
    const blocked: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'agent.limit.warning') warnings.push(event);
      if (event.type === 'limit.blocked') blocked.push(event);
    });
    const runtime = await createRuntime({
      provider: new OneToolCallProvider(),
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      pluginHost: noopHost(),
      limits: { requestLimit: 1, toolCallsLimit: 1000 },
      maxIterations: 50,
    });

    await expect(runtime.run('go')).rejects.toThrow('Usage limits exceeded');

    expect(warnings).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });

  it('warns for termination limits at 80% as well', async () => {
    const events = new MemoryEventStream();
    const warnings: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'agent.limit.warning') warnings.push(event);
    });
    const runtime = await createRuntime({
      provider: new ToolLoopProvider(),
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      pluginHost: noopHost(),
      limits: {},
      maxIterations: 5,
    });

    await expect(runtime.run('go')).rejects.toThrow('Termination policy triggered');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({
      key: 'max_iterations',
      current: 4,
      max: 5,
      source: 'termination.maxIterations',
      threshold: 0.8,
    });
  });
});
