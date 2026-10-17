import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  GuardrailStage,
  HookType,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type Plugin,
  type RunEvent,
  type ToolContext,
  type ToolDefinition,
} from '@vessel/core';
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
  provider: MemoryLLMProvider,
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
  it('子 agent 继承父级 guardrail，违规工具调用被拦截', async () => {
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

    const result = await runtime.run('PARENT_FORBIDDEN');
    expect(result).toContain('blocked by guardrail');
    expect(events.getHistory().some((e) => e.type === 'subagent.delegate.failed')).toBe(true);
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
