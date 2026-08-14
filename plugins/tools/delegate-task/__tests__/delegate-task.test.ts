import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  MemoryToolRegistry,
  type RunEvent,
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

    const tools = new MemoryToolRegistry();
    tools.register(echoTool());
    const events = new MemoryEventStream();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      tools,
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

    const tools = new MemoryToolRegistry();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
      maxDepth: 1,
      disallowed: [],
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      tools,
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

    const tools = new MemoryToolRegistry();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => provider,
      model: 'test-model',
    });
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      tools,
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
