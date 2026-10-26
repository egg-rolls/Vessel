/**
 * Context pressure：80%–90% 只提示 rotate（尾部 vessel:limit + context.pressure），
 * ≥90% 交给自动压缩；同一 run 只提示一次，不重复。
 */

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
  type RunEvent,
} from '../src/index';

const SYSTEM_PROMPT = 'BASE-SYSTEM';
const MAX_TOKENS = 1000;

/**
 * 每轮返回相同 usage，前 `toolCallRounds` 次返回 tool_calls（结果内容可控），之后 stop。
 * `prompt_tokens` 直接决定 Core 看到的上下文比例。
 */
class PressureProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  constructor(
    private readonly promptTokens: number,
    private readonly toolCallRounds: number,
  ) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const call = this.requests.length;
    const usage = {
      prompt_tokens: this.promptTokens,
      completion_tokens: 0,
      total_tokens: this.promptTokens,
    };
    if (call <= this.toolCallRounds) {
      return {
        content: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: `call-${call}`, type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
        usage,
      };
    }
    return { content: 'done', finish_reason: 'stop', usage };
  }
}

function noopHost(result: string): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name: 'noop',
    description: 'noop',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  });
  return host;
}

function systemContent(request: ChatRequest | undefined): string | undefined {
  return request?.messages.find((message) => message.role === 'system')?.content;
}

function limitMessages(request: ChatRequest | undefined) {
  return (request?.messages ?? []).filter((message) => message.name === 'vessel:limit');
}

async function createRuntime(
  provider: PressureProvider,
  context: MemoryContextManager,
  events: MemoryEventStream,
  result: string,
): Promise<AgentRuntime> {
  return AgentRuntime.create({
    provider,
    model: 'test-model',
    systemPrompt: SYSTEM_PROMPT,
    context,
    events,
    pluginHost: noopHost(result),
    session: new MemorySessionBackend(),
    limits: {},
    termination: { maxIterations: 20 },
  });
}

describe('context pressure warning (80%–90%)', () => {
  it('at 82% emits one vessel:limit tail message and one context.pressure event; no compaction', async () => {
    const provider = new PressureProvider(820, 2);
    const events = new MemoryEventStream();
    const pressure: RunEvent[] = [];
    const compacted: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'context.pressure') pressure.push(event);
      if (event.type === 'context.compacted') compacted.push(event);
    });

    const context = new MemoryContextManager({ maxTokens: MAX_TOKENS });
    const runtime = await createRuntime(provider, context, events, 'ok');

    await expect(runtime.run('go')).resolves.toBe('done');

    // 3 轮请求：第 2 轮预警后每轮都能看到同一条尾部消息。
    expect(provider.requests).toHaveLength(3);
    expect(limitMessages(provider.requests[0])).toHaveLength(0);
    for (const request of provider.requests.slice(1)) {
      const messages = limitMessages(request);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
      expect(messages[0]?.content).toBe(
        '[runtime] context_window: 820/1000 (82%) — Use agent(rotate) with a startup_prompt to move to a fresh body; automatic compaction runs above 90%.',
      );
    }
    // 注入时位于尾部：第二轮请求的最后一条。
    expect(provider.requests[1]?.messages.at(-1)?.name).toBe('vessel:limit');

    // 82% 不压缩，80% 预警只发一次（同一 run 内不重复）。
    expect(compacted).toHaveLength(0);
    expect(pressure).toHaveLength(1);
    expect(typeof pressure[0]?.run_id).toBe('string');
    expect(pressure[0]?.data).toMatchObject({
      session_id: 'default',
      used: 820,
      max: MAX_TOKENS,
      ratio: 0.82,
      threshold: 0.8,
    });

    // system 始终是原基底，未被尾部消息改写。
    for (const request of provider.requests) {
      expect(systemContent(request)).toBe(SYSTEM_PROMPT);
    }
  });

  it('near 90% compacts and emits no 80% warning', async () => {
    // 901/1000 已越过 0.9 阈值（shouldCompact 为严格大于）。
    const provider = new PressureProvider(901, 1);
    const events = new MemoryEventStream();
    const pressure: RunEvent[] = [];
    const compacted: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'context.pressure') pressure.push(event);
      if (event.type === 'context.compacted') compacted.push(event);
    });

    // 配置 summarizer 让 add() 延迟压缩，由 runtime 的 autoCompactAsync 真正执行。
    const context = new MemoryContextManager({
      maxTokens: MAX_TOKENS,
      summarizer: async () => 'SUMMARY',
    });
    const runtime = await createRuntime(provider, context, events, 'x'.repeat(1200));

    await expect(runtime.run('go')).resolves.toBe('done');

    expect(compacted).toHaveLength(1);
    const compactedData = compacted[0]?.data as { reason?: string; removed?: number } | undefined;
    expect(compactedData).toMatchObject({ reason: 'auto' });
    expect(compactedData?.removed ?? 0).toBeGreaterThan(0);
    expect(pressure).toHaveLength(0);
    for (const request of provider.requests) {
      expect(limitMessages(request)).toHaveLength(0);
      expect(systemContent(request)).toBe(SYSTEM_PROMPT);
    }
  });

  it('autoCompact: false keeps 90%+ from compacting proactively', async () => {
    const provider = new PressureProvider(901, 1);
    const events = new MemoryEventStream();
    const pressure: RunEvent[] = [];
    const compacted: RunEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'context.pressure') pressure.push(event);
      if (event.type === 'context.compacted') compacted.push(event);
    });

    const context = new MemoryContextManager({
      maxTokens: MAX_TOKENS,
      autoCompact: false,
    });
    const runtime = await createRuntime(provider, context, events, 'x'.repeat(1200));

    await expect(runtime.run('go')).resolves.toBe('done');

    // 显式关闭优先：没有主动压缩，也不发 80% 预警（由 overflow 兜底，本用例不触发）。
    expect(compacted).toHaveLength(0);
    expect(pressure).toHaveLength(0);
    for (const request of provider.requests) {
      expect(limitMessages(request)).toHaveLength(0);
    }
  });
});
