/**
 * thinking 模式 reasoning_content 测试
 *
 * DeepSeek 等 OpenAI 兼容端点要求：assistant(tool_calls) 的 reasoning_content
 * 必须在下一轮请求里原样回传。同时思维链不得进入事件流 / TUI。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { OpenAICompatibleProvider } from '../src/provider/providers';
import { StreamAccumulator } from '../src/provider/stream-accumulator';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { SQLiteSessionBackend } from '../src/session/sqlite-backend';
import type { LLMResponse, Message, StreamChunk } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** mock 非流式 JSON 响应 */
function mockFetchJson(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** mock OpenAI SSE 响应 */
function mockFetchSse(sseChunks: string[]): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

describe('OpenAI 兼容 reasoning_content', () => {
  it('非流式解析 choice.message.reasoning_content', async () => {
    mockFetchJson({
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'think' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    const provider = new OpenAICompatibleProvider({ api_key: 'k', model: 'm' });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    });

    expect(response.content).toBe('answer');
    expect(response.reasoning_content).toBe('think');
  });

  it('请求映射只在 assistant 消息上回传 reasoning_content', async () => {
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const messages: Message[] = [
      { role: 'system', content: 's', reasoning_content: 'not-sent' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        reasoning_content: 'think-tool',
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r', reasoning_content: 'not-sent' },
      { role: 'assistant', content: 'done', reasoning_content: 'think-final' },
      { role: 'user', content: 'hi' },
    ];

    const provider = new OpenAICompatibleProvider({ api_key: 'k', model: 'm' });
    await provider.chat({ messages, model: 'm' });

    expect(body?.messages[0]?.reasoning_content).toBeUndefined();
    expect(body?.messages[1]?.reasoning_content).toBe('think-tool');
    expect(body?.messages[2]?.reasoning_content).toBeUndefined();
    expect(body?.messages[3]?.reasoning_content).toBe('think-final');
    expect('reasoning_content' in (body?.messages[4] ?? {})).toBe(false);
  });

  it('流式累积 delta.reasoning_content，且不产生 reasoning chunk', async () => {
    mockFetchSse([
      `data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n`,
      `data: {"choices":[{"delta":{"reasoning_content":" more"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"answer"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const chunks: StreamChunk[] = [];
    const provider = new OpenAICompatibleProvider({ api_key: 'k', model: 'm' });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      stream: true,
      on_chunk: (chunk) => chunks.push(chunk),
    });

    expect(response.content).toBe('answer');
    expect(response.reasoning_content).toBe('think more');
    // 思维链不进入 on_chunk（即不会发 llm.stream.chunk 事件）
    expect(JSON.stringify(chunks)).not.toContain('think');
    expect(chunks.every((c) => c.type === 'text_delta' || c.type === 'finish')).toBe(true);
  });
});

describe('StreamAccumulator reasoning', () => {
  it('appendReasoning 只累积、不回调；finalize 返回 reasoning_content', () => {
    const chunks: StreamChunk[] = [];
    const accumulator = new StreamAccumulator((chunk) => chunks.push(chunk));

    accumulator.appendReasoning('a');
    accumulator.appendReasoning('b');

    expect(chunks).toHaveLength(0);
    const response = accumulator.finalize();
    expect(response.reasoning_content).toBe('ab');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('finish');
  });
});

describe('runtime reasoning_content 生命周期', () => {
  it('上下文保留、下一轮请求回传、事件不泄漏', async () => {
    const captured: Message[][] = [];
    let calls = 0;
    const provider = {
      chat: async (req: { messages: Message[] }): Promise<LLMResponse> => {
        captured.push(req.messages);
        calls++;
        if (calls === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'noop', arguments: '{}' },
              },
            ],
            reasoning_content: 'SECRET-THINK',
          };
        }
        return {
          content: 'done',
          finish_reason: 'stop',
          reasoning_content: 'FINAL-THINK',
        };
      },
    };

    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'r',
    };
    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool(tool);
    const events = new MemoryEventStream();
    const context = new MemoryContextManager();

    const runtime = await AgentRuntime.create({
      provider,
      model: 'm',
      pluginHost,
      context,
      events,
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });

    await runtime.run('hi');

    // runtime 上下文保留 reasoning
    const toolAssistant = context.messages.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(toolAssistant?.reasoning_content).toBe('SECRET-THINK');
    const finalAssistant = [...context.messages].reverse().find((m) => m.role === 'assistant');
    expect(finalAssistant?.reasoning_content).toBe('FINAL-THINK');

    // 第二次请求把 assistant(tool_calls) 的 reasoning 原样回传
    const secondRequestToolAssistant = captured[1]?.find(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(secondRequestToolAssistant?.reasoning_content).toBe('SECRET-THINK');

    // 事件流（llm.request / context.changed 等）不泄漏思维链
    const dumped = JSON.stringify(events.getHistory());
    expect(dumped).not.toContain('SECRET-THINK');
    expect(dumped).not.toContain('FINAL-THINK');
  });

  it('session 持久化与恢复保留 reasoning_content', async () => {
    const backend = new SQLiteSessionBackend(':memory:');
    try {
      await backend.save({
        run_id: 'run-1',
        session_id: 's1',
        status: 'completed',
        started_at: 1,
        completed_at: 2,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } },
            ],
            reasoning_content: 'think-tool',
          },
          { role: 'tool', tool_call_id: 'c1', content: 'r' },
        ],
      });

      const loaded = await backend.load('s1');
      expect(loaded?.messages[1]?.reasoning_content).toBe('think-tool');
    } finally {
      backend.close();
    }
  });
});
