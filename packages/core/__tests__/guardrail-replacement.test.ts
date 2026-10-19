import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { GuardrailStage } from '../src/types/guardrail';
import type { Message } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

/** 工具调用一次后返回 stop 的 provider */
function toolCallThenStop(args = '{}') {
  let calls = 0;
  return {
    chat: async () => {
      calls++;
      if (calls === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls' as const,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: 'noop', arguments: args },
            },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
}

function createHost(tool?: ToolDefinition): MemoryPluginHost {
  const host = new MemoryPluginHost();
  if (tool) host.registerTool(tool);
  return host;
}

describe('Guardrail replacement 生效（C-05）', () => {
  it('Input 阶段改写持久化的用户消息', async () => {
    const host = createHost();
    host.registerGuardrail({
      name: 'redact-input',
      stage: GuardrailStage.Input,
      check: async () => ({ allowed: true, replacement: 'redacted input' }),
    });

    const captured: Message[][] = [];
    const provider = {
      chat: async (req: { messages: Message[] }) => {
        captured.push(req.messages);
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('raw input');

    const userMessages = captured[0]?.filter((m) => m.role === 'user') ?? [];
    expect(userMessages[userMessages.length - 1]?.content).toBe('redacted input');
    // 持久化的也是改写后的内容（不是原文）
    expect(context.messages.some((m) => m.content === 'raw input')).toBe(false);
  });

  it('Output 阶段改写返回值与持久化的 assistant 消息', async () => {
    const host = createHost();
    host.registerGuardrail({
      name: 'redact-output',
      stage: GuardrailStage.Output,
      check: async () => ({ allowed: true, replacement: 'safe output' }),
    });
    const provider = {
      chat: async () => ({ content: 'raw output', finish_reason: 'stop' as const }),
    };
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: host,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await runtime.run('hi');

    expect(response).toBe('safe output');
    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('safe output');
  });

  it('ToolCall 阶段改写 arguments，handler 收到改写后的参数', async () => {
    let received: unknown;
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => {
        received = args;
        return 'ok';
      },
    };
    const host = createHost(tool);
    host.registerGuardrail({
      name: 'rewrite-call',
      stage: GuardrailStage.ToolCall,
      check: async (value) => {
        const call = value as {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        };
        return {
          allowed: true,
          replacement: {
            ...call,
            function: { ...call.function, arguments: '{"x":"rewritten"}' },
          },
        };
      },
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop('{}'),
      model: 'test-model',
      pluginHost: host,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    expect(received).toEqual({ x: 'rewritten' });
    // 上下文里的 assistant tool_calls 也应是改写后的参数，保证与 tool 结果配对
    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"x":"rewritten"}');
  });

  it('ToolResult 阶段改写写入上下文与事件的结果', async () => {
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'raw result',
    };
    const host = createHost(tool);
    host.registerGuardrail({
      name: 'redact-result',
      stage: GuardrailStage.ToolResult,
      check: async () => ({ allowed: true, replacement: 'safe result' }),
    });
    const events = new MemoryEventStream();
    const completed: string[] = [];
    events.subscribe((event) => {
      if (event.type === 'tool.call.completed') {
        completed.push((event.data as unknown as { result: string }).result);
      }
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop(),
      model: 'test-model',
      pluginHost: host,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    expect(completed).toEqual(['safe result']);
    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('safe result');
  });

  it('ToolCall 阻断折回 tool 错误，不终止 run', async () => {
    let handlerCalled = false;
    const host = createHost({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalled = true;
        return 'ok';
      },
    });
    host.registerGuardrail({
      name: 'deny-call',
      stage: GuardrailStage.ToolCall,
      check: async () => ({ allowed: false, reason: 'policy denied' }),
    });
    const events = new MemoryEventStream();
    const failures: string[] = [];
    events.subscribe((event) => {
      if (event.type === 'tool.call.failed') {
        failures.push((event.data as unknown as { error: string }).error);
      }
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop(),
      model: 'test-model',
      pluginHost: host,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await runtime.run('hi');

    expect(response).toBe('done');
    expect(handlerCalled).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('policy denied');
    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('Error: Tool call blocked by guardrail: policy denied');
    // assistant 消息仍保留该调用，保证 tool_calls / tool 结果配对
    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0]?.id).toBe('call-1');
  });

  it('ToolResult 阻断折回 tool 错误，不发布 completed', async () => {
    const host = createHost({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'secret result',
    });
    host.registerGuardrail({
      name: 'deny-result',
      stage: GuardrailStage.ToolResult,
      check: async () => ({ allowed: false, reason: 'pii detected' }),
    });
    const events = new MemoryEventStream();
    const completed: string[] = [];
    events.subscribe((event) => {
      if (event.type === 'tool.call.completed') completed.push(event.type);
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop(),
      model: 'test-model',
      pluginHost: host,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    const response = await runtime.run('hi');

    expect(response).toBe('done');
    expect(completed).toHaveLength(0);
    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('Error: Tool result blocked by guardrail: pii detected');
    expect(context.messages.some((m) => m.content === 'secret result')).toBe(false);
  });

  it('非法 replacement 类型按未改写处理', async () => {
    const host = createHost({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'raw result',
    });
    host.registerGuardrail({
      name: 'bad-replacement',
      stage: GuardrailStage.ToolResult,
      check: async () => ({ allowed: true, replacement: 42 }),
    });
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider: toolCallThenStop(),
      model: 'test-model',
      pluginHost: host,
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    const toolMessage = context.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('raw result');
  });
});
