import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type Message,
  type SelfCardOptions,
} from '../src/index';

/** 第一次返回 tool_calls，之后 stop；记录每次请求的消息 */
class TwoPhaseRecordingProvider implements LLMProvider {
  readonly requests: Message[][] = [];
  calls = 0;

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req.messages);
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      };
    }
    return { content: 'done', finish_reason: 'stop' };
  }
}

class RecordingProvider implements LLMProvider {
  readonly requests: Message[][] = [];

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req.messages);
    return { content: 'done', finish_reason: 'stop' };
  }
}

function noopHost(): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name: 'noop',
    description: 'noop',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
  return host;
}

const CARD: SelfCardOptions = {
  role: 'worker',
  parent_id: 'root',
  depth: 2,
  model: 'test-model',
  tools: ['noop'],
  limits: { requestLimit: 10, maxIterations: 20, maxRuntimeSeconds: 300 },
  context: { max: 100000 },
  how_to_ask: 'Message the parent agent.',
};

function countCard(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
    count += message.content.split('[Self Card]').length - 1;
  }
  return count;
}

function systemMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.role === 'system');
}

describe('Self Card injection (0.15 E9)', () => {
  it('injects the card exactly once per request, even across tool iterations', async () => {
    const provider = new TwoPhaseRecordingProvider();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      context: new MemoryContextManager({ autoCompact: false }),
      events: new MemoryEventStream(),
      pluginHost: noopHost(),
      session: new MemorySessionBackend(),
      limits: {},
      termination: { maxIterations: 20 },
      systemPrompt: 'BASE PROMPT',
      selfCard: CARD,
    });

    await runtime.run('go');

    expect(provider.requests.length).toBe(2);
    for (const messages of provider.requests) {
      const systems = systemMessages(messages);
      expect(systems).toHaveLength(1);
      expect(countCard(messages)).toBe(1);
      const content = systems[0]?.content ?? '';
      expect(content).toContain('BASE PROMPT');
      expect(content).toContain('[Self Card]');
      expect(content).toContain('role: worker');
      expect(content).toContain('parent: root');
      expect(content).toContain('depth: 2');
      expect(content).toContain('model: test-model');
      expect(content).toContain('tools: noop');
      expect(content).toContain('requests 0/10');
      expect(content).toContain('iterations 0/20');
      expect(content).toContain('runtime 0s/300s');
      expect(content).toContain('how to ask for help: Message the parent agent.');
    }
  });

  it('does not inject anything when selfCard is omitted', async () => {
    const provider = new RecordingProvider();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      context: new MemoryContextManager({ autoCompact: false }),
      events: new MemoryEventStream(),
      pluginHost: new MemoryPluginHost(),
      session: new MemorySessionBackend(),
      limits: {},
      termination: { maxIterations: 20 },
      systemPrompt: 'BASE PROMPT',
    });

    await runtime.run('go');

    const messages = provider.requests[0] ?? [];
    const systems = systemMessages(messages);
    expect(systems).toHaveLength(1);
    expect(systems[0]?.content).toBe('BASE PROMPT');
    expect(countCard(messages)).toBe(0);
  });
});
