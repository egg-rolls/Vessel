import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  GuardrailStage,
  HookType,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type Message,
  type Plugin,
  type RunEvent,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';
import { createDelegateTaskPlugin } from '../src/index';

/** 从 run 事件 data 安全读取 depth（不用 as） */
function eventDepth(event: RunEvent | undefined): number | undefined {
  const data = event?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const depth = (data as Record<string, unknown>).depth;
  return typeof depth === 'number' ? depth : undefined;
}

/** echo 工具：子任务用的「安全工具」 */
function echoTool(): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
    handler: async (args: unknown) => {
      if (typeof args !== 'object' || args === null) return 'echo: ';
      const text = (args as Record<string, unknown>).text;
      return `echo: ${typeof text === 'string' ? text : ''}`;
    },
  };
}

/** 构造一次 tool_calls 响应（参数 JSON 化） */
function toolCallResponse(callId: string, name: string, args: Record<string, unknown>) {
  return {
    content: '',
    finish_reason: 'tool_calls' as const,
    tool_calls: [
      {
        id: callId,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

describe('delegate-task 插件（子 agent 分派）', () => {
  it('install 注册 delegate_task 工具（task 必填）', () => {
    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
    });
    plugin.install(host);
    const tool = host.getTool('delegate_task');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['task'],
    });
  });

  it('父 run 触发 delegate_task，返回子任务结果，且深度计数正确', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'DO_DELEGATE',
      toolCallResponse('tc-parent', 'delegate_task', {
        task: 'DO_ECHO hello world',
      }),
    );
    provider.setResponse(
      'DO_ECHO',
      toolCallResponse('tc-child', 'echo', {
        text: 'hello world',
      }),
    );

    const host = new MemoryPluginHost();
    host.registerTool(echoTool());
    const events = new MemoryEventStream();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events,
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [plugin],
    });

    const result = await runtime.run('DO_DELEGATE now');
    expect(result).toContain('hello world');

    // 深度计数正确：父层 spawn 事件 depth 为 0
    const started = events.getHistory().find((e) => e.type === 'subagent.delegate.started');
    expect(started).toBeDefined();
    expect(eventDepth(started)).toBe(0);

    // 子 runtime 事件已转发到父 ctx.events（subagent.* 前缀）
    expect(events.getHistory().some((e) => e.type === 'subagent.run.started')).toBe(true);
    expect(events.getHistory().some((e) => e.type === 'subagent.run.completed')).toBe(true);
  });

  it('递归 delegate 被深度上限阻断', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'START_NEST',
      toolCallResponse('t1', 'delegate_task', {
        task: 'NEST_ONCE more',
      }),
    );
    provider.setResponse(
      'NEST_ONCE',
      toolCallResponse('t2', 'delegate_task', {
        task: 'third level',
      }),
    );

    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      maxDepth: 1,
      disallowed: [],
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [plugin],
    });

    const result = await runtime.run('START_NEST');
    expect(result).toContain('depth exceeded');
  });

  it('子 agent 白名单默认排除 delegate_task（递归被阻断）', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'START_WL',
      toolCallResponse('t1', 'delegate_task', {
        task: 'NEST_WL again',
      }),
    );
    provider.setResponse(
      'NEST_WL',
      toolCallResponse('t2', 'delegate_task', {
        task: 'third level',
      }),
    );

    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {},
      termination: { maxIterations: 10 },
      plugins: [plugin],
    });

    const result = await runtime.run('START_WL');
    expect(result).toContain('not found');
  });

  it('delegate_task 缺 task 参数返回错误提示', async () => {
    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
    });
    plugin.install(host);
    const tool = host.getTool('delegate_task');
    expect(tool).toBeDefined();
    const result = await tool?.handler(
      {},
      {
        run_id: 'r1',
        messages: [],
        events: new MemoryEventStream(),
      },
    );
    expect(result).toContain('non-empty task');
  });
});

/** 注册一个无副作用工具 */
function registerTool(host: MemoryPluginHost, name: string, result = `${name}-result`): void {
  host.registerTool({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  });
}

/** 构造一个父 runtime（plugin 安装到同一个 host） */
async function makeRuntime(
  provider: LLMProvider,
  host: MemoryPluginHost,
  events: MemoryEventStream,
  plugin: Plugin,
): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider,
    model: 'test-model',
    pluginHost: host,
    context: new MemoryContextManager(),
    events,
    limits: {},
    termination: { maxIterations: 10 },
    plugins: [plugin],
  });
}

describe('delegate-task 安全继承', () => {
  it('子 agent 继承父级 guardrail：违规调用折回错误，delegate 正常完成', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_FORBIDDEN',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_FORBIDDEN' }),
    );
    provider.setResponse('CHILD_FORBIDDEN', toolCallResponse('c1', 'forbidden', {}));

    const host = new MemoryPluginHost();
    registerTool(host, 'forbidden', 'should not run');
    host.registerGuardrail({
      name: 'deny-forbidden',
      stage: GuardrailStage.ToolCall,
      check: async (value) => {
        const name =
          typeof value === 'object' && value !== null
            ? ((value as { function?: { name?: string } }).function?.name ?? '')
            : '';
        return name === 'forbidden'
          ? { allowed: false, reason: 'forbidden tool blocked' }
          : { allowed: true };
      },
    });

    const events = new MemoryEventStream();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await makeRuntime(provider, host, events, plugin);

    // 新语义：child run 不 throw，delegate 正常返回含拦截原因的文本
    const result = await runtime.run('PARENT_FORBIDDEN');
    expect(result).toContain('blocked by guardrail');
    expect(result).toContain('forbidden');
    const types = events.getHistory().map((event) => event.type);
    expect(types).toContain('subagent.delegate.completed');
    expect(types).not.toContain('subagent.delegate.failed');
  });

  it('子 agent 继承父级 hook', async () => {
    let hookRuns = 0;
    const host = new MemoryPluginHost();
    host.registerHook({
      name: 'count-before-llm',
      type: HookType.BeforeLlm,
      run: async () => {
        hookRuns++;
      },
    });
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_HOOK',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_HOOK' }),
    );
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await makeRuntime(provider, host, new MemoryEventStream(), plugin);

    await runtime.run('PARENT_HOOK');

    // 父 2 次 LLM 调用 + 子至少 1 次；若 hook 未继承则只有 2
    expect(hookRuns).toBeGreaterThan(2);
  });

  it('bridge 模式把子 agent 的权限请求转发给父事件流', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_PERM',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_PERM' }),
    );
    provider.setResponse('CHILD_PERM', toolCallResponse('c1', 'needs_perm', {}));

    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'needs_perm',
      description: 'needs permission',
      inputSchema: { type: 'object', properties: {} },
      checkPermission: async (_input: unknown, ctx: ToolContext) => {
        const requestId = 'req-child-1';
        ctx.events.publish({
          type: 'tool.permission.request',
          run_id: ctx.run_id,
          data: { requestId, tool: 'needs_perm' },
          ts: Date.now(),
        });
        const response = (await ctx.events.waitFor('tool.permission.response', {
          requestId,
          timeout: 5000,
        })) as { decision?: 'allow' | 'deny' } | undefined;
        return response?.decision ?? 'deny';
      },
      handler: async () => 'granted-result',
    });

    const events = new MemoryEventStream();
    const seen: string[] = [];
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      if (typeof event.data !== 'object' || event.data === null) return;
      seen.push(String((event.data as Record<string, unknown>).tool));
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          decision: 'allow',
        },
        ts: Date.now(),
      });
    });

    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await makeRuntime(provider, host, events, plugin);

    const result = await runtime.run('PARENT_PERM');
    expect(result).toContain('granted-result');
    // 父级收到的是原事件名（不是 subagent.* 前缀），且工具名正确
    expect(seen).toContain('needs_perm');
  });

  it('allow 模式自动放行子 agent 的权限请求', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_ALLOW',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_ALLOW' }),
    );
    provider.setResponse('CHILD_ALLOW', toolCallResponse('c1', 'asks', {}));

    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'asks',
      description: 'asks for permission',
      inputSchema: { type: 'object', properties: {} },
      checkPermission: async () => 'ask',
      handler: async () => 'auto-allowed',
    });

    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      permissionMode: 'allow',
    });
    const runtime = await makeRuntime(provider, host, new MemoryEventStream(), plugin);

    const result = await runtime.run('PARENT_ALLOW');
    expect(result).toContain('auto-allowed');
  });

  it('deny 模式只保留只读工具', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_DENY',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_DENY' }),
    );
    provider.setResponse('CHILD_DENY', toolCallResponse('c1', 'write_tool', {}));

    const host = new MemoryPluginHost();
    registerTool(host, 'read', 'read-ok');
    registerTool(host, 'write_tool', 'write-ok');

    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      permissionMode: 'deny',
    });
    const runtime = await makeRuntime(provider, host, new MemoryEventStream(), plugin);

    const result = await runtime.run('PARENT_DENY');
    expect(result).toContain('not found');
  });
});

describe('delegate-task 事件与并发', () => {
  it('completed / 转发事件带 delegateId 与用量', async () => {
    const provider = new MemoryLLMProvider();
    provider.setResponse(
      'PARENT_EVENT',
      toolCallResponse('p1', 'delegate_task', { task: 'CHILD_EVENT' }),
    );
    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, host, events, plugin);

    await runtime.run('PARENT_EVENT');

    const history = events.getHistory();
    const completed = history.find((e) => e.type === 'subagent.delegate.completed');
    expect(completed).toBeDefined();
    const data = completed?.data as Record<string, unknown>;
    expect(typeof data?.delegateId).toBe('string');
    expect(typeof data?.duration_ms).toBe('number');
    const totalTokens = (data?.usage as Record<string, unknown> | undefined)?.total_tokens;
    expect(typeof totalTokens).toBe('number');
    expect(Number(totalTokens)).toBeGreaterThan(0);

    const forwarded = history.find((e) => e.type === 'subagent.run.started');
    expect((forwarded?.data as Record<string, unknown>)?.delegateId).toBe(data?.delegateId);
  });

  it('并行 delegate 的深度计数互不污染', async () => {
    const provider = new MemoryLLMProvider();
    const host = new MemoryPluginHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    plugin.install(host);
    const tool = host.getTool('delegate_task');
    if (!tool) throw new Error('delegate_task not registered');

    const eventsA = new MemoryEventStream();
    const eventsB = new MemoryEventStream();
    await Promise.all([
      tool.handler({ task: 'A' }, { run_id: 'run-a', messages: [], events: eventsA }),
      tool.handler({ task: 'B' }, { run_id: 'run-b', messages: [], events: eventsB }),
    ]);

    const startedA = eventsA.getHistory().find((e) => e.type === 'subagent.delegate.started');
    const startedB = eventsB.getHistory().find((e) => e.type === 'subagent.delegate.started');
    const dataA = startedA?.data as Record<string, unknown>;
    const dataB = startedB?.data as Record<string, unknown>;

    expect(dataA?.depth).toBe(0);
    expect(dataB?.depth).toBe(0);
    expect(dataA?.delegateId).not.toBe(dataB?.delegateId);
  });
});

/** 记录每次请求消息的 mock provider（用于断言 thinking 字段是否回传） */
class RecordingProvider implements LLMProvider {
  readonly requests: Message[][] = [];
  private index = 0;

  constructor(private readonly responses: LLMResponse[]) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req.messages));
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`no preset response for call ${this.index}`);
    return response;
  }
}

describe('delegate-task thinking 模式（reasoning_content）', () => {
  it('子 agent 多轮 tool call 时回传 reasoning，且父/子事件不暴露', async () => {
    const provider = new RecordingProvider([
      // 父第一次：委派子任务
      {
        content: '',
        finish_reason: 'tool_calls',
        reasoning_content: 'PARENT-THINK-1',
        tool_calls: [
          {
            id: 'p1',
            type: 'function',
            function: { name: 'delegate_task', arguments: JSON.stringify({ task: 'CHILD_TASK' }) },
          },
        ],
      },
      // 子第一次：调用 echo
      {
        content: '',
        finish_reason: 'tool_calls',
        reasoning_content: 'CHILD-THINK-1',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
      },
      // 子第二次：看到 tool 结果后收尾
      { content: 'child done', finish_reason: 'stop', reasoning_content: 'CHILD-THINK-2' },
      // 父第二次：看到 delegate 结果后收尾
      { content: 'parent done', finish_reason: 'stop', reasoning_content: 'PARENT-THINK-2' },
    ]);

    const host = new MemoryPluginHost();
    registerTool(host, 'echo', 'echo-ok');
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const events = new MemoryEventStream();
    const runtime = await makeRuntime(provider, host, events, plugin);

    const result = await runtime.run('PARENT_TASK');

    expect(result).toBe('parent done');
    expect(provider.requests).toHaveLength(4);

    // 子 agent 第二次请求：assistant(tool_calls) 必须原样带上第一轮的 reasoning_content
    const childSecond = provider.requests[2] ?? [];
    const childAssistant = childSecond.find(
      (msg) =>
        msg.role === 'assistant' &&
        msg.tool_calls?.some((call) => call.function.name === 'echo') === true,
    );
    expect(childAssistant?.reasoning_content).toBe('CHILD-THINK-1');

    // 父 agent 第二次请求：带自己的 reasoning；且子 agent 的思维链不进入父上下文
    const parentSecond = provider.requests[3] ?? [];
    const parentAssistant = parentSecond.find(
      (msg) =>
        msg.role === 'assistant' &&
        msg.tool_calls?.some((call) => call.function.name === 'delegate_task') === true,
    );
    expect(parentAssistant?.reasoning_content).toBe('PARENT-THINK-1');
    expect(parentSecond.some((msg) => msg.reasoning_content?.includes('CHILD-THINK'))).toBe(false);

    // 事件流（含 subagent.* 转发）不暴露任何思维链；UI 只消费事件
    const serializedEvents = JSON.stringify(events.getHistory());
    expect(serializedEvents).not.toContain('PARENT-THINK');
    expect(serializedEvents).not.toContain('CHILD-THINK');
    expect(result).not.toContain('THINK');
  });
});
