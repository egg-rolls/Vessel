import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { ChatRequest, LLMResponse } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

describe('ToolDefinition.display（0.14.1）', () => {
  it('listTools 原样透出 display，且不进入 LLM 工具 schema', async () => {
    const pluginHost = new MemoryPluginHost();
    const tool: ToolDefinition = {
      name: 'run_tests',
      description: 'run tests',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
      display: { label: 'Run tests', kind: 'command' },
    };
    pluginHost.registerTool(tool);

    expect(pluginHost.listTools()[0]?.display).toEqual({ label: 'Run tests', kind: 'command' });
    expect(JSON.parse(JSON.stringify(pluginHost.listTools()))[0]?.display).toEqual({
      label: 'Run tests',
      kind: 'command',
    });

    const requests: ChatRequest[] = [];
    const provider = {
      chat: async (req: ChatRequest): Promise<LLMResponse> => {
        requests.push(req);
        return { content: 'done', finish_reason: 'stop' as const };
      },
    };
    const runtime = await AgentRuntime.create({
      provider,
      model: 'm',
      pluginHost,
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    const schema = requests[0]?.tools?.[0]?.function;
    expect(schema?.name).toBe('run_tests');
    expect(schema).not.toHaveProperty('display');
    expect(JSON.stringify(requests[0]?.tools)).not.toContain('Run tests');

    await runtime.dispose();
  });
});
