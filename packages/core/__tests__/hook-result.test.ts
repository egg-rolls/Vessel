import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { HookType } from '../src/types/hook';
import type { LLMProvider, Message } from '../src/types/provider';

function toolThenStop(toolName: string, args = '{}') {
  let requests = 0;
  return {
    chat: async () => {
      requests += 1;
      if (requests === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls' as const,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: toolName, arguments: args },
            },
          ],
        };
      }
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
}

function baseOptions(
  host: MemoryPluginHost,
  provider: LLMProvider,
  context = new MemoryContextManager(),
) {
  return {
    provider,
    model: 'test-model',
    pluginHost: host,
    context,
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 10 },
  };
}

describe('HookResult rewriting (0.6.1 P2)', () => {
  it('passes tool/input to BeforeTool and applies updatedInput', async () => {
    let received: unknown;
    const seen: Array<{ tool?: unknown; input?: unknown }> = [];
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => {
        received = args;
        return 'ok';
      },
    });
    host.registerHook({
      name: 'rewrite-input',
      type: HookType.BeforeTool,
      run: async (ctx) => {
        seen.push({ tool: ctx.tool, input: ctx.input });
        return { updatedInput: { x: 'rewritten' } };
      },
    });

    const runtime = await AgentRuntime.create(
      baseOptions(host, toolThenStop('noop', '{"x":"original"}')),
    );
    await runtime.run('hi');

    expect(seen).toEqual([{ tool: 'noop', input: { x: 'original' } }]);
    expect(received).toEqual({ x: 'rewritten' });
  });

  it('folds a BeforeTool block back as a tool error without aborting the run', async () => {
    let called = false;
    const host = new MemoryPluginHost();
    host.registerTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        called = true;
        return 'ok';
      },
    });
    host.registerHook({
      name: 'deny-tool',
      type: HookType.BeforeTool,
      run: async () => ({ block: true, reason: 'not allowed here' }),
    });

    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create(baseOptions(host, toolThenStop('noop'), context));
    const response = await runtime.run('hi');

    expect(response).toBe('done');
    expect(called).toBe(false);
    expect(context.messages.find((m) => m.role === 'tool')?.content).toBe(
      'Error: Tool call blocked by hook: not allowed here',
    );
  });

  it('appends BeforeLlm additionalContext to the system prompt', async () => {
    const captured: Message[][] = [];
    const host = new MemoryPluginHost();
    host.registerHook({
      name: 'extra-context',
      type: HookType.BeforeLlm,
      run: async () => ({ additionalContext: 'EXTRA CONTEXT' }),
    });
    const provider = {
      chat: async (req: { messages: Message[] }) => {
        captured.push(req.messages);
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };

    const runtime = await AgentRuntime.create({
      ...baseOptions(host, provider),
      systemPrompt: 'BASE PROMPT',
    });
    await runtime.run('hi');

    expect(captured[0]?.[0]).toMatchObject({
      role: 'system',
      content: 'BASE PROMPT\n\nEXTRA CONTEXT',
    });
  });
});
