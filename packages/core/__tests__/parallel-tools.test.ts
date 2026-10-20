import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { ToolCall, ToolDefinition } from '../src/types/tool';

function providerWithCalls(calls: ToolCall[]) {
  let requests = 0;
  return {
    chat: async () => {
      requests += 1;
      if (requests === 1) {
        return { content: '', finish_reason: 'tool_calls' as const, tool_calls: calls };
      }
      return { content: 'done', finish_reason: 'stop' as const };
    },
  };
}

function call(id: string, name: string, args = '{}'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function tool(
  name: string,
  handler: ToolDefinition['handler'],
  concurrencySafe = true,
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    concurrencySafe,
    handler,
  };
}

async function runWith(
  tools: ToolDefinition[],
  calls: ToolCall[],
): Promise<{ context: MemoryContextManager; events: MemoryEventStream }> {
  const host = new MemoryPluginHost();
  for (const item of tools) host.registerTool(item);
  const context = new MemoryContextManager();
  const events = new MemoryEventStream();
  const runtime = await AgentRuntime.create({
    provider: providerWithCalls(calls),
    model: 'test-model',
    pluginHost: host,
    context,
    events,
    limits: { requestLimit: 10, toolCallsLimit: 10 },
    termination: { maxIterations: 10 },
  });
  await runtime.run('hi');
  return { context, events };
}

describe('parallel concurrency-safe tools (0.6.1 P1)', () => {
  it('runs consecutive safe calls concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const delay = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const makeHandler =
      (name: string): ToolDefinition['handler'] =>
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
        return name;
      };

    await runWith(
      [tool('a', makeHandler('a')), tool('b', makeHandler('b'))],
      [call('call-a', 'a'), call('call-b', 'b')],
    );

    expect(maxActive).toBe(2);
  });

  it('writes results back in original call order', async () => {
    const fast = tool('fast', async () => 'FAST');
    const slow = tool('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'SLOW';
    });

    const { context } = await runWith(
      [fast, slow],
      [call('call-slow', 'slow'), call('call-fast', 'fast')],
    );

    const toolMessages = context.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.content)).toEqual(['SLOW', 'FAST']);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call-slow', 'call-fast']);
  });

  it('does not join safe calls across an unsafe call', async () => {
    let active = 0;
    let maxActive = 0;
    const delay = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const makeHandler =
      (name: string, safe: boolean): ToolDefinition['handler'] =>
      async () => {
        if (!safe) return name;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        return name;
      };

    const { context } = await runWith(
      [
        tool('a', makeHandler('a', true), true),
        tool('danger', makeHandler('danger', false), false),
        tool('c', makeHandler('c', true), true),
      ],
      [call('call-a', 'a'), call('call-danger', 'danger'), call('call-c', 'c')],
    );

    expect(maxActive).toBe(1);
    expect(context.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      'a',
      'danger',
      'c',
    ]);
  });

  it('folds parallel failures back in order without aborting the run', async () => {
    const ok = tool('ok', async () => 'OK');
    const failing = tool('failing', async () => {
      throw new Error('boom');
    });

    const { context } = await runWith(
      [failing, ok],
      [call('call-fail', 'failing'), call('call-ok', 'ok')],
    );

    const contents = context.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(contents).toEqual(['Error: boom', 'OK']);
  });
});
