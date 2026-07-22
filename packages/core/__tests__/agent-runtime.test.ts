import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryLLMProvider } from '../src/provider/providers';
import { MemoryToolRegistry } from '../src/tools/tool-registry';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemorySessionBackend } from '../src/session/session-backend';
import { EventType } from '../src/types/event';
import type { ToolDefinition } from '../src/types/tool';

describe('AgentRuntime Integration', () => {
  let runtime: AgentRuntime;
  let provider: MemoryLLMProvider;
  let tools: MemoryToolRegistry;
  let context: MemoryContextManager;
  let eventStream: MemoryEventStream;
  let session: MemorySessionBackend;

  beforeEach(() => {
    provider = new MemoryLLMProvider();
    tools = new MemoryToolRegistry();
    context = new MemoryContextManager();
    eventStream = new MemoryEventStream();
    session = new MemorySessionBackend();

    runtime = new AgentRuntime({
      provider,
      model: 'test-model',
      tools,
      context,
      events: eventStream,
      limits: {
        request_limit: 10,
        tool_calls_limit: 5,
      },
      termination: {
        max_iterations: 10,
        stop_on_no_tool_calls: true,
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
    const eventTypes = receivedEvents.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain(EventType.RunStarted);
    expect(eventTypes).toContain(EventType.RunCompleted);
    expect(eventTypes).toContain(EventType.LlmRequest);
    expect(eventTypes).toContain(EventType.LlmResponse);

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

    const toolCallRuntime = new AgentRuntime({
      provider: customProvider,
      model: 'test-model',
      tools,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {
        request_limit: 10,
        tool_calls_limit: 5,
      },
      termination: {
        max_iterations: 10,
        stop_on_no_tool_calls: true,
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
});
