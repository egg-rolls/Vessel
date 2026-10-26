import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionBackend,
  type Message,
} from '../src/index';

/**
 * 提示词缓存稳定性：system 前缀必须跨 run 字节一致（价格优先于上下文大小）。
 * Self Card 只能包含静态字段；实时 context.used 不能进入 system。
 */
function capturingProvider(captured: Message[][]) {
  return {
    chat: async (req: { messages: Message[] }) => {
      captured.push(req.messages.map((message) => ({ ...message })));
      return { content: 'ok', finish_reason: 'stop' as const };
    },
  };
}

async function makeRuntime(captured: Message[][]) {
  return AgentRuntime.create({
    provider: capturingProvider(captured),
    model: 'test-model',
    context: new MemoryContextManager(),
    events: new MemoryEventStream(),
    pluginHost: new MemoryPluginHost(),
    session: new MemorySessionBackend(),
    limits: {},
    termination: { maxIterations: 1 },
    systemPrompt: 'BASE PROMPT',
    selfCard: {
      role: 'worker',
      depth: 1,
      model: 'test-model',
      tools: ['read'],
      limits: {},
      context: { max: 1000 },
      how_to_ask: 'non-interactive',
    },
  });
}

function systemOf(messages: Message[] | undefined): string {
  const first = messages?.[0];
  return first?.role === 'system' ? (first.content ?? '') : '';
}

describe('prompt cache stability', () => {
  it('keeps the system prefix byte-identical across runs even as context grows', async () => {
    const captured: Message[][] = [];
    const runtime = await makeRuntime(captured);

    await runtime.run('first');
    await runtime.run('second');

    const firstSystem = systemOf(captured[0]);
    const secondSystem = systemOf(captured[1]);
    expect(firstSystem).toContain('[Self Card]');
    expect(firstSystem).toContain('context: 1000 tokens (budget)');
    expect(firstSystem).not.toMatch(/context: \d+\/1000/);
    expect(secondSystem).toBe(firstSystem);

    await runtime.dispose();
  });

  it('keeps prior user/assistant messages unchanged between runs', async () => {
    const captured: Message[][] = [];
    const runtime = await makeRuntime(captured);

    await runtime.run('first');
    await runtime.run('second');

    const first = captured[0] ?? [];
    const second = captured[1] ?? [];
    // 第二轮 = 第一轮完整前缀 + 新 turn；前缀必须逐条相等。
    expect(second.slice(0, first.length)).toEqual(first);

    await runtime.dispose();
  });
});
