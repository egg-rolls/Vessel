/**
 * `limits.toolCallsLimit` 软预算：到达上限不再让 run 失败，而是切换为无工具收尾。
 */
import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  LimitExceededError,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type RunEvent,
} from '../src/index';

/** 每个请求都返回一个 tool_call（收尾请求也一样），用于验证不会无限循环。 */
class AlwaysToolCallsProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return {
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: `call-${this.requests.length}`,
          type: 'function',
          function: { name: 'noop', arguments: '{}' },
        },
      ],
    };
  }
}

/** 前 `toolTurns` 次返回 tool_calls，之后返回最终文本。 */
class ToolThenStopProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly toolTurns: number) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    if (this.requests.length <= this.toolTurns) {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: `call-${this.requests.length}`,
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          },
        ],
      };
    }
    return { content: 'final answer', finish_reason: 'stop' };
  }
}

function noopHost(): { host: MemoryPluginHost; executions: () => number } {
  const host = new MemoryPluginHost();
  let calls = 0;
  host.registerTool({
    name: 'noop',
    description: 'noop',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      calls++;
      return 'ok';
    },
  });
  return { host, executions: () => calls };
}

function budgetNoticeMessages(request: ChatRequest | undefined) {
  return (request?.messages ?? []).filter(
    (message) =>
      message.name === 'vessel:limit' && message.content.includes('tool call budget exhausted'),
  );
}

describe('toolCallsLimit soft budget', () => {
  it('executes exactly N tools, then completes with one no-tool finish request', async () => {
    const provider = new AlwaysToolCallsProvider();
    const events = new MemoryEventStream();
    const session = new MemorySessionBackend();
    const { host, executions } = noopHost();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      session,
      limits: { requestLimit: 100, toolCallsLimit: 3 },
      termination: { maxIterations: 100 },
    });

    const output = await runtime.run('go');

    // 恰好执行 N 次工具；收尾请求不带 tools；模型即使仍要工具也不再执行。
    expect(executions()).toBe(3);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.tools).toBeUndefined();
    expect(output).toBe('[runtime] tool call budget exhausted; no final answer was produced.');

    const state = await session.load('default');
    expect(state?.status).toBe('completed');

    const history = events.getHistory();
    expect(history.some((event) => event.type === 'run.failed')).toBe(false);
    expect(history.some((event) => event.type === 'limit.blocked')).toBe(false);

    const warnings = history.filter((event) => event.type === 'limit.warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({
      scope: 'run',
      key: 'tool_calls_limit',
      current: 3,
      max: 3,
      source: 'limits.toolCallsLimit',
    });

    // 收尾提示只注入一次，模型在收尾请求里能看到。
    expect(budgetNoticeMessages(provider.requests[0])).toHaveLength(0);
    expect(budgetNoticeMessages(provider.requests[3])).toHaveLength(1);
  });

  it('uses the model final text when the no-tool request does stop', async () => {
    const provider = new ToolThenStopProvider(3);
    const events = new MemoryEventStream();
    const session = new MemorySessionBackend();
    const { host, executions } = noopHost();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      session,
      limits: { requestLimit: 100, toolCallsLimit: 3 },
      termination: { maxIterations: 100 },
    });

    await expect(runtime.run('go')).resolves.toBe('final answer');

    expect(executions()).toBe(3);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.tools).toBeUndefined();
    expect((await session.load('default'))?.status).toBe('completed');
    expect(events.getHistory().some((event) => event.type === 'run.failed')).toBe(false);
  });

  it('does not emit the budget notice or event before the limit is reached', async () => {
    const provider = new ToolThenStopProvider(1);
    const events = new MemoryEventStream();
    const { host, executions } = noopHost();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      limits: { requestLimit: 100, toolCallsLimit: 10 },
      termination: { maxIterations: 100 },
    });

    await expect(runtime.run('go')).resolves.toBe('final answer');

    expect(executions()).toBe(1);
    expect(provider.requests).toHaveLength(2);
    expect(events.getHistory().some((event: RunEvent) => event.type === 'limit.warning')).toBe(
      false,
    );
    for (const request of provider.requests) {
      expect(budgetNoticeMessages(request)).toHaveLength(0);
    }
  });

  it('restores tools on the next run without an unexplained prefix change', async () => {
    const provider = new ToolThenStopProvider(3);
    const events = new MemoryEventStream();
    const { host } = noopHost();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      limits: { requestLimit: 100, toolCallsLimit: 3 },
      termination: { maxIterations: 100 },
    });

    await expect(runtime.run('first')).resolves.toBe('final answer');
    // 第二次 run 恢复完整工具集；不应因 tools 从空恢复而报无 reason 的前缀变化。
    await expect(runtime.run('second')).resolves.toBe('final answer');

    expect(
      events.getHistory().filter((event) => event.type === 'prompt.prefix_changed'),
    ).toHaveLength(0);
  });

  it('keeps requestLimit a hard failure even when toolCallsLimit is configured', async () => {
    const provider = new AlwaysToolCallsProvider();
    const events = new MemoryEventStream();
    const session = new MemorySessionBackend();
    const { host } = noopHost();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager({ autoCompact: false }),
      events,
      session,
      limits: { requestLimit: 2, toolCallsLimit: 10 },
      termination: { maxIterations: 100 },
    });

    let thrown: unknown;
    try {
      await runtime.run('go');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LimitExceededError);
    expect((thrown as LimitExceededError).details.key).toBe('request_limit');
    expect((await session.load('default'))?.status).toBe('failed');

    const history = events.getHistory();
    expect(history.filter((event) => event.type === 'limit.blocked')).toHaveLength(1);
    expect(history.filter((event) => event.type === 'run.failed')).toHaveLength(1);
    expect(history.some((event) => event.type === 'limit.warning')).toBe(false);
  });
});
