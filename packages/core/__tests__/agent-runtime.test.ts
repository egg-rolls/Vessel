import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemorySessionBackend } from '../src/session/session-backend';
import { HookType } from '../src/types/hook';
import type { ToolDefinition } from '../src/types/tool';

/** 构造"第一次 user 消息返回 tool_calls，之后返回 stop"的 provider */
function toolCallThenStopProvider(toolName: string) {
  return {
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      const lastMessage = req.messages[req.messages.length - 1];
      if (lastMessage?.role === 'user') {
        return {
          content: '',
          finish_reason: 'tool_calls' as const,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: toolName, arguments: '{}' },
            },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
}

describe('AgentRuntime Integration', () => {
  let runtime: AgentRuntime;
  let provider: MemoryLLMProvider;
  let pluginHost: MemoryPluginHost;
  let context: MemoryContextManager;
  let eventStream: MemoryEventStream;
  let session: MemorySessionBackend;

  beforeEach(async () => {
    provider = new MemoryLLMProvider();
    pluginHost = new MemoryPluginHost();
    context = new MemoryContextManager();
    eventStream = new MemoryEventStream();
    session = new MemorySessionBackend();

    runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context,
      events: eventStream,
      limits: {
        requestLimit: 10,
        toolCallsLimit: 5,
      },
      termination: {
        maxIterations: 10,
      },
      session,
    });
  });

  it('should handle simple text response', async () => {
    const response = await runtime.run('Hello');

    expect(response).toBe('Echo: Hello');
  });

  it('should emit events during run', async () => {
    const receivedEvents: unknown[] = [];
    const unsubscribe = eventStream.subscribe((event) => {
      receivedEvents.push(event);
    });

    await runtime.run('Test');

    expect(receivedEvents.length).toBeGreaterThan(0);
    // 应该有 RunStarted 和 RunCompleted 事件
    const eventTypes = receivedEvents.map((e) => (e as { type: string }).type);
    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('run.completed');
    expect(eventTypes).toContain('llm.request');
    expect(eventTypes).toContain('llm.response');
    // 流式（ADR-007/016）：MemoryLLMProvider 经 on_chunk 吐增量，runtime 发 LlmStreamChunk
    expect(eventTypes).toContain('llm.stream.chunk');

    unsubscribe();
  });

  it('should publish context.changed events during run (ADR-031)', async () => {
    const changedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = eventStream.subscribe((event) => {
      if (event.type === 'context.changed') {
        changedEvents.push(event as { type: string; data: Record<string, unknown> });
      }
    });

    await runtime.run('Hello');

    // 至少发布 user/assistant 消息的 context.changed
    expect(changedEvents.length).toBeGreaterThan(0);
    const last = changedEvents[changedEvents.length - 1] as {
      type: string;
      data: Record<string, unknown>;
    };
    expect((last.data as { message_count: number }).message_count).toBeGreaterThan(0);
    unsubscribe();
  });

  it('should emit LlmStreamChunk events whose text deltas reassemble into the response', async () => {
    const streamChunks: unknown[] = [];
    const unsubscribe = eventStream.subscribe((event) => {
      if (event.type === 'llm.stream.chunk') {
        const payload = event as { data: { chunk: { type: string; delta?: string } } };
        streamChunks.push(payload.data.chunk);
      }
    });

    const response = await runtime.run('Hello');

    const textDeltas = streamChunks
      .filter((c) => (c as { type: string }).type === 'text_delta')
      .map((c) => (c as { delta?: string }).delta ?? '')
      .join('');

    // 流式增量拼接应等于最终响应
    expect(textDeltas).toBe(response);
    // 应以 finish chunk 收尾
    const last = streamChunks[streamChunks.length - 1] as { type: string };
    expect(last?.type).toBe('finish');

    unsubscribe();
  });

  it('should handle tool calls', async () => {
    // 注册一个工具
    const weatherTool: ToolDefinition = {
      name: 'get_weather',
      description: 'Get weather information',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
      handler: async (args) => {
        const { city } = args as { city: string };
        return `The weather in ${city} is sunny!`;
      },
    };

    pluginHost.registerTool(weatherTool);

    // 创建一个新的 provider 来跟踪调用
    const callLog: string[] = [];
    const customProvider = {
      chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const lastMessage = req.messages[req.messages.length - 1];
        if (!lastMessage) {
          return { content: '', finish_reason: 'stop' as const };
        }
        callLog.push(lastMessage.content);

        // 第一次调用（用户消息）返回工具调用
        if (lastMessage.role === 'user') {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Beijing"}',
                },
              },
            ],
          };
        }

        // 第二次调用（工具结果后）返回最终响应
        return {
          content: 'The weather in Beijing is sunny!',
          finish_reason: 'stop' as const,
        };
      },
    };

    const toolCallRuntime = await AgentRuntime.create({
      provider: customProvider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {
        requestLimit: 10,
        toolCallsLimit: 5,
      },
      termination: {
        maxIterations: 10,
      },
    });

    const response = await toolCallRuntime.run('What is the weather in Beijing?');

    expect(response).toContain('sunny');
    expect(callLog.length).toBe(2); // 应该调用了2次 LLM
  });

  it('tool.timeout 在 loop 生效：超时工具发 tool.call.failed（ADR-017 2b 回归）', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'hanging',
      description: 'Hangs forever',
      inputSchema: { type: 'object', properties: {} },
      timeout: 50,
      handler: () => new Promise<string>(() => {}), // 永不 resolve，只能靠 timeout 中断
    });

    const events = new MemoryEventStream();
    const failed: Array<{ tool_name: string; error: string }> = [];
    events.subscribe((event) => {
      if (event.type === 'tool.call.failed') {
        const data = event.data as unknown as { tool_name: string; error: string };
        failed.push({ tool_name: data.tool_name, error: data.error });
      }
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('hanging'),
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await runtime.run('use hanging');

    expect(response).toBe('done');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.tool_name).toBe('hanging');
    expect(failed[0]?.error).toContain('timed out after 50ms');
  });

  it('should save session state', async () => {
    await runtime.run('Test message', 'test-session');

    const savedState = await session.load('test-session');
    expect(savedState).not.toBeNull();
    expect(savedState?.session_id).toBe('test-session');
    expect(savedState?.status).toBe('completed');
  });

  it('发送全部已注册工具（不再有 default 过滤）', async () => {
    const firstTool: ToolDefinition = {
      name: 'first_tool',
      description: 'First tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'first result',
    };

    const secondTool: ToolDefinition = {
      name: 'second_tool',
      description: 'Second tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'second result',
    };

    const host = new MemoryPluginHost();
    host.registerTool(firstTool);
    host.registerTool(secondTool);

    let capturedTools: string[] = [];

    const customProvider = {
      chat: async (req: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = (req.tools ?? []).map((t) => t.function.name);
        return { content: 'ok', finish_reason: 'stop' as const };
      },
    };

    const filterRuntime = await AgentRuntime.create({
      provider: customProvider,
      model: 'test-model',
      pluginHost: host,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await filterRuntime.run('Test');

    expect(capturedTools).toContain('first_tool');
    expect(capturedTools).toContain('second_tool');
    expect(capturedTools).toHaveLength(2);
  });

  it('runtime.pluginHost 公开只读：可读到插件注册的工具', async () => {
    pluginHost.registerTool({
      name: 'public_tool',
      description: 'Visible via runtime.pluginHost',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });

    expect(runtime.pluginHost.listTools().map((t) => t.name)).toContain('public_tool');
  });

  it('RunOptions.messages 注入消息先于用户输入持久化（C5）', async () => {
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'test-model',
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('user input', 'inj-session', {
      messages: [
        { role: 'user', content: '<file path="a.md">AAA</file>' },
        { role: 'user', content: 'BBB' },
      ],
    });

    // 注入消息在前，用户输入在后，全部持久化
    expect(context.messages[0]?.content).toContain('AAA');
    expect(context.messages[1]?.content).toBe('BBB');
    expect(context.messages[2]?.content).toBe('user input');
  });

  it('checkPermission ask -> 发布 tool.permission.request，用户 allow 后放行工具（ADR-029）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = false;
    let requestedCount = 0;
    const guardedTool: ToolDefinition = {
      name: 'guarded',
      description: 'Guarded tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan = true;
        return 'guarded result';
      },
      checkPermission: async () => 'ask',
    };
    pluginHost.registerTool(guardedTool);

    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        requestedCount++;
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId: data.requestId, decision: 'allow' },
          ts: Date.now(),
        });
      }
    });

    const customProvider = {
      chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const lastMessage = req.messages[req.messages.length - 1];
        if (lastMessage?.role === 'user') {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: { name: 'guarded', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };

    const permRuntime = await AgentRuntime.create({
      provider: customProvider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await permRuntime.run('use guarded');

    expect(response).toBe('done');
    expect(toolRan).toBe(true); // 用户允许后工具执行
    expect(requestedCount).toBe(1); // 发过 1 次权限请求
  });

  it('checkPermission ask -> 用户 deny 后工具被阻止（不执行 handler）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = false;
    const guardedTool: ToolDefinition = {
      name: 'guarded',
      description: 'Guarded tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan = true;
        return 'guarded result';
      },
      checkPermission: async () => 'ask',
    };
    pluginHost.registerTool(guardedTool);

    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId: data.requestId, decision: 'deny' },
          ts: Date.now(),
        });
      }
    });

    const customProvider = {
      chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const lastMessage = req.messages[req.messages.length - 1];
        if (lastMessage?.role === 'user') {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: { name: 'guarded', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };

    const denyRuntime = await AgentRuntime.create({
      provider: customProvider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await denyRuntime.run('use guarded');

    expect(response).toBe('done');
    expect(toolRan).toBe(false); // 用户拒绝，handler 未执行
  });

  it('checkPermission deny -> 策略拒绝，工具被阻止（不执行 handler）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = false;
    const guardedTool: ToolDefinition = {
      name: 'guarded',
      description: 'Guarded tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan = true;
        return 'guarded result';
      },
      checkPermission: async () => 'deny',
    };
    pluginHost.registerTool(guardedTool);

    const customProvider = {
      chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const lastMessage = req.messages[req.messages.length - 1];
        if (lastMessage?.role === 'user') {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: { name: 'guarded', arguments: '{}' },
              },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };

    const denyRuntime = await AgentRuntime.create({
      provider: customProvider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await denyRuntime.run('use guarded');

    expect(response).toBe('done');
    expect(toolRan).toBe(false); // 策略拒绝，handler 未执行
  });

  it('默认权限策略 default=ask：未声明 checkPermission 的工具也经事件流确认（ADR-029）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'plain',
      description: 'Plain tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'plain result';
      },
    });

    const events = new MemoryEventStream();
    let requested = 0;
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        requested++;
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId: data.requestId, decision: 'allow' },
          ts: Date.now(),
        });
      }
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('plain'),
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    const response = await runtime.run('use plain');

    expect(response).toBe('done');
    expect(toolRan).toBe(1);
    expect(requested).toBe(1); // 未声明 checkPermission 也走了权限确认
  });

  it('默认权限策略 autoApprove：免确认工具直接执行，不发权限请求', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'plain',
      description: 'Plain tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'plain result';
      },
    });

    const events = new MemoryEventStream();
    let requested = 0;
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') requested++;
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('plain'),
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask', autoApprove: ['plain'] },
    });

    const response = await runtime.run('use plain');

    expect(response).toBe('done');
    expect(toolRan).toBe(1);
    expect(requested).toBe(0); // autoApprove 免确认
  });

  it('库默认 permission=allow：未配置时工具直接执行，不发权限请求', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'plain',
      description: 'Plain tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'plain result';
      },
    });

    const events = new MemoryEventStream();
    let requested = 0;
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') requested++;
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('plain'),
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      // 不传 permission → 默认 'allow'
    });

    const response = await runtime.run('use plain');

    expect(response).toBe('done');
    expect(toolRan).toBe(1);
    expect(requested).toBe(0);
  });

  it('默认权限策略 remember（always）：记住批准，后续同工具免确认', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'plain',
      description: 'Plain tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'plain result';
      },
    });

    const events = new MemoryEventStream();
    let requested = 0;
    events.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        requested++;
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: 'tool.permission.response',
          run_id: event.run_id,
          data: { requestId: data.requestId, decision: 'allow', remember: true },
          ts: Date.now(),
        });
      }
    });

    const runtime = await AgentRuntime.create({
      provider: toolCallThenStopProvider('plain'),
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      permission: { default: 'ask' },
    });

    await runtime.run('use plain'); // 第一次：请求 + remember
    const response = await runtime.run('use plain again'); // 第二次：已记住，免确认

    expect(response).toBe('done');
    expect(toolRan).toBe(2);
    expect(requested).toBe(1); // 第二次不再发权限请求
  });
});

describe('工具失败与上下文持久化（C-01/C-02）', () => {
  it('非法 tool arguments JSON 不终止 run，折回 role:tool 错误（C-01）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolRan = 0;
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        toolRan++;
        return 'ok';
      },
    });

    const events = new MemoryEventStream();
    const failures: Array<{ tool_name: string; error: string }> = [];
    events.subscribe((event) => {
      if (event.type === 'tool.call.failed') {
        failures.push(event.data as unknown as { tool_name: string; error: string });
      }
    });

    let calls = 0;
    const provider = {
      chat: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'bad-args',
                type: 'function' as const,
                function: { name: 'noop', arguments: '{bad' },
              },
            ],
          };
        }
        return { content: 'recovered', finish_reason: 'stop' as const };
      },
    };

    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await runtime.run('bad args');

    expect(response).toBe('recovered');
    expect(toolRan).toBe(0); // 参数解析失败，handler 不应执行
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain('Invalid JSON');
    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('Invalid JSON');
  });

  it('run 失败时持久化真实上下文（user/assistant/tool 都保留，C-02）', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'tool-result',
    });

    let calls = 0;
    const provider = {
      chat: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'c1',
                type: 'function' as const,
                function: { name: 'noop', arguments: '{}' },
              },
            ],
          };
        }
        throw new Error('boom');
      },
    };

    const session = new MemorySessionBackend();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session,
    });

    await expect(runtime.run('hello', 's-fail')).rejects.toThrow('boom');

    const saved = await session.load('s-fail');
    expect(saved?.status).toBe('failed');
    expect(saved?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(saved?.messages[2]?.content).toBe('tool-result');
  });

  it('第二轮失败时保留第一轮历史（C-02 回归）', async () => {
    let calls = 0;
    const provider = {
      chat: async () => {
        calls++;
        if (calls === 1) {
          return { content: 'first reply', finish_reason: 'stop' as const };
        }
        throw new Error('second boom');
      },
    };

    const session = new MemorySessionBackend();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session,
    });

    await runtime.run('first', 's2');
    await expect(runtime.run('second', 's2')).rejects.toThrow('second boom');

    const saved = await session.load('s2');
    expect(saved?.messages.length).toBeGreaterThanOrEqual(3);
    expect(saved?.messages[0]?.content).toBe('first');
  });
});

describe('真实 token 语义（C-04）', () => {
  it('使用本次请求 token 而非累计值，不误触发 compact', async () => {
    let compacted = 0;
    const context = new MemoryContextManager({
      // 显式钉住旧默认预算，回归场景不随全局默认值变化而失效
      maxTokens: 4096,
      onCompact: () => {
        compacted++;
      },
    });
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'r',
    });

    let calls = 0;
    const provider = {
      chat: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls' as const,
            tool_calls: [
              {
                id: 'c1',
                type: 'function' as const,
                function: { name: 'noop', arguments: '{}' },
              },
            ],
            usage: { prompt_tokens: 3000, completion_tokens: 100, total_tokens: 3100 },
          };
        }
        return {
          content: 'done',
          finish_reason: 'stop' as const,
          usage: { prompt_tokens: 3100, completion_tokens: 50, total_tokens: 3150 },
        };
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    // 修复前：第二轮累计 3100 + 3150 = 6250 > 4096*0.8，会误触发 compact
    expect(compacted).toBe(0);
    expect(context.tokenCount).toBe(3150);
  });
});

describe('中断与限额（C-09）', () => {
  it('AbortSignal 用户取消：发 run.cancelled、RunState 写 cancelled、触发 OnError', async () => {
    const events = new MemoryEventStream();
    const session = new MemorySessionBackend();
    let onError = 0;
    const runtime = await AgentRuntime.create({
      provider: {
        chat: async () => ({ content: 'never', finish_reason: 'stop' as const }),
      },
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context: new MemoryContextManager(),
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session,
      plugins: [
        {
          name: 'on-error',
          install(host) {
            host.registerHook({
              name: 'err',
              type: HookType.OnError,
              run: async () => {
                onError++;
              },
            });
          },
        },
      ],
    });

    const controller = new AbortController();
    controller.abort('cancelled by test');

    await expect(runtime.run('hi', undefined, { signal: controller.signal })).rejects.toThrow(
      'cancelled by test',
    );
    expect(events.getHistory().some((e) => e.type === 'run.cancelled')).toBe(true);
    expect(events.getHistory().some((e) => e.type === 'run.failed')).toBe(false);
    expect((await session.load('default'))?.status).toBe('cancelled');
    expect(onError).toBe(1);
  });

  it('Host 中断 reason：RunState 保持 failed（与 checkpoint interrupted 区分）', async () => {
    const session = new MemorySessionBackend();
    const runtime = await AgentRuntime.create({
      provider: {
        chat: async () => ({ content: 'never', finish_reason: 'stop' as const }),
      },
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      session,
    });

    const controller = new AbortController();
    controller.abort('agent closed');

    await expect(runtime.run('hi', 's-interrupt', { signal: controller.signal })).rejects.toThrow(
      'agent closed',
    );
    expect((await session.load('s-interrupt'))?.status).toBe('failed');
  });

  it('maxIterations 到达后终止（C-09）', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });

    let calls = 0;
    const provider = {
      chat: async () => {
        calls++;
        return {
          content: '',
          finish_reason: 'tool_calls' as const,
          tool_calls: [
            { id: 'c1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } },
          ],
        };
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 1 },
    });

    await expect(runtime.run('loop')).rejects.toThrow('Termination policy');
    expect(calls).toBe(1);
  });

  it('requestLimit 到达后终止（C-09）', async () => {
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });

    const provider = {
      chat: async () => ({
        content: '',
        finish_reason: 'tool_calls' as const,
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } },
        ],
      }),
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 1, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await expect(runtime.run('loop')).rejects.toThrow('Usage limits exceeded');
  });

  it('ToolContext.signal 注入并可响应取消（F10）', async () => {
    const pluginHost = new MemoryPluginHost();
    let toolSignal: AbortSignal | undefined;
    let toolAborted = false;
    let markStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    pluginHost.registerTool({
      name: 'waiter',
      description: 'waits for abort',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        toolSignal = ctx.signal;
        markStarted();
        return await new Promise<string>((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => {
              toolAborted = true;
              reject(new Error('tool aborted'));
            },
            { once: true },
          );
        });
      },
    });

    const provider = {
      chat: async () => ({
        content: '',
        finish_reason: 'tool_calls' as const,
        tool_calls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'waiter', arguments: '{}' },
          },
        ],
      }),
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const controller = new AbortController();
    const runPromise = runtime.run('go', undefined, { signal: controller.signal });
    await toolStarted;

    // 0.10 R2-18：signal 由 runtime 内部 controller 承载（与调用方 signal 桥接），
    // 不再是同一个对象；契约是“外部 abort 必须传播到工具”。
    expect(toolSignal?.aborted).toBe(false);
    controller.abort('stop');

    await expect(runPromise).rejects.toThrow('stop');
    expect(toolAborted).toBe(true);
    expect(toolSignal?.aborted).toBe(true);
  });
});
