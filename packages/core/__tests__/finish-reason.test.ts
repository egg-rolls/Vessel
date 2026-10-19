import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { Message } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

describe('finish_reason tolerance (0.6.1 P1)', () => {
  it('continues the tool round when stop carries tool_calls', async () => {
    let handlerCalls = 0;
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalls += 1;
        return 'ok';
      },
    };

    let requests = 0;
    const provider = {
      chat: async (req: { messages: Message[] }) => {
        requests += 1;
        if (req.messages.at(-1)?.role === 'tool') {
          return { content: 'done', finish_reason: 'stop' as const };
        }
        return {
          content: 'calling',
          // 兼容 provider 的怪异组合：stop 但带 tool_calls
          finish_reason: 'stop' as const,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: 'noop', arguments: '{}' },
            },
          ],
        };
      },
    };

    const host = new MemoryPluginHost();
    host.registerTool(tool);
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

    expect(response).toBe('done');
    expect(requests).toBe(2);
    expect(handlerCalls).toBe(1);
    expect(context.messages.find((m) => m.role === 'tool')?.content).toBe('ok');
  });

  it('still treats a stop response without tool_calls as final', async () => {
    let requests = 0;
    const provider = {
      chat: async () => {
        requests += 1;
        return { content: 'final', finish_reason: 'stop' as const };
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    expect(await runtime.run('hi')).toBe('final');
    expect(requests).toBe(1);
  });
});
