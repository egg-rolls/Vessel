import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemorySessionBackend } from '../src/session/session-backend';
import { MemoryToolRegistry } from '../src/tools/tool-registry';
import { EventType } from '../src/types/event';
import type { ToolDefinition } from '../src/types/tool';

describe('AgentRuntime Integration', () => {
  let runtime: AgentRuntime;
  let provider: MemoryLLMProvider;
  let tools: MemoryToolRegistry;
  let context: MemoryContextManager;
  let eventStream: MemoryEventStream;
  let session: MemorySessionBackend;

  beforeEach(async () => {
    provider = new MemoryLLMProvider();
    tools = new MemoryToolRegistry();
    context = new MemoryContextManager();
    eventStream = new MemoryEventStream();
    session = new MemorySessionBackend();

    runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      tools,
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
    expect(eventTypes).toContain(EventType.RunStarted);
    expect(eventTypes).toContain(EventType.RunCompleted);
    expect(eventTypes).toContain(EventType.LlmRequest);
    expect(eventTypes).toContain(EventType.LlmResponse);
    // 流式（ADR-007/016）：MemoryLLMProvider 经 on_chunk 吐增量，runtime 发 LlmStreamChunk
    expect(eventTypes).toContain(EventType.LlmStreamChunk);

    unsubscribe();
  });

  it('should emit LlmStreamChunk events whose text deltas reassemble into the response', async () => {
    const streamChunks: unknown[] = [];
    const unsubscribe = eventStream.subscribe((event) => {
      if (event.type === EventType.LlmStreamChunk) {
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

    tools.register(weatherTool);

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
      tools,
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

  it('should save session state', async () => {
    await runtime.run('Test message', 'test-session');

    const savedState = await session.load('test-session');
    expect(savedState).not.toBeNull();
    expect(savedState?.session_id).toBe('test-session');
    expect(savedState?.status).toBe('completed');
  });

  it('should only send default tools to LLM (SPEC §4.2)', async () => {
    // 注册两个工具：一个默认可见，一个默认不可见
    const visibleTool: ToolDefinition = {
      name: 'visible_tool',
      description: 'Always visible',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'visible result',
      default: true,
    };

    const hiddenTool: ToolDefinition = {
      name: 'hidden_tool',
      description: 'Hidden by default',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'hidden result',
      default: false,
    };

    // 未设置 default 的工具应视为默认可见
    const implicitTool: ToolDefinition = {
      name: 'implicit_tool',
      description: 'Implicitly visible',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'implicit result',
    };

    const filterTools = new MemoryToolRegistry();
    filterTools.register(visibleTool);
    filterTools.register(hiddenTool);
    filterTools.register(implicitTool);

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
      tools: filterTools,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await filterRuntime.run('Test');

    // visible_tool (default: true) 和 implicit_tool (default 未设置) 应该被发送
    expect(capturedTools).toContain('visible_tool');
    expect(capturedTools).toContain('implicit_tool');
    // hidden_tool (default: false) 不应该被发送
    expect(capturedTools).not.toContain('hidden_tool');
    // 总共应发送 2 个工具
    expect(capturedTools).toHaveLength(2);
  });
});
