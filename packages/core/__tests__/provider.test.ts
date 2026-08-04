import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryLLMProvider, OpenAICompatibleProvider } from '../src/provider/providers';
import type { ChatRequest, StreamChunk } from '../src/types/provider';

describe('MemoryLLMProvider', () => {
  let provider: MemoryLLMProvider;

  beforeEach(() => {
    provider = new MemoryLLMProvider();
  });

  it('should return echo response by default', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'test-model',
    };

    const response = await provider.chat(request);

    expect(response.content).toBe('Echo: Hello');
    expect(response.finish_reason).toBe('stop');
    expect(response.usage).toBeDefined();
    expect(response.usage?.prompt_tokens).toBe(5);
  });

  it('should return preset responses', async () => {
    provider.setResponse('weather', {
      content: 'The weather is sunny!',
      finish_reason: 'stop',
    });

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'What is the weather?' }],
      model: 'test-model',
    };

    const response = await provider.chat(request);

    expect(response.content).toBe('The weather is sunny!');
  });

  it('should track call count', async () => {
    expect(provider.getCallCount()).toBe(0);

    await provider.chat({
      messages: [{ role: 'user', content: 'Test 1' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(1);

    await provider.chat({
      messages: [{ role: 'user', content: 'Test 2' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(2);
  });

  it('should reset call count', async () => {
    await provider.chat({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(1);

    provider.resetCallCount();

    expect(provider.getCallCount()).toBe(0);
  });
});

describe('MemoryLLMProvider streaming', () => {
  it('should emit text_delta + finish chunks and return full response', async () => {
    const provider = new MemoryLLMProvider();
    const chunks: StreamChunk[] = [];

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'test-model',
      stream: true,
      on_chunk: (c) => chunks.push(c),
    };

    const response = await provider.chat(request);

    // 返回值与非流式一致
    expect(response.content).toBe('Echo: Hello');
    expect(response.finish_reason).toBe('stop');

    // 应有 text_delta + finish
    const types = chunks.map((c) => c.type);
    expect(types).toContain('text_delta');
    expect(types[types.length - 1]).toBe('finish');

    // text_delta 拼接 == 完整 content
    const reassembled = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => c.delta ?? '')
      .join('');
    expect(reassembled).toBe('Echo: Hello');
  });

  it('should return identical response when on_chunk absent (non-stream path)', async () => {
    const provider = new MemoryLLMProvider();

    const streamResp = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'test',
      stream: true,
      on_chunk: () => undefined,
    });
    const plainResp = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'test',
    });

    expect(streamResp.content).toBe(plainResp.content);
    expect(streamResp.usage).toEqual(plainResp.usage);
  });
});

/** 用 ReadableStream 构造 OpenAI SSE 响应，mock globalThis.fetch */
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

describe('OpenAICompatibleProvider streaming', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should stream text deltas and assemble full response', async () => {
    mockFetchSse([
      `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" world"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const provider = new OpenAICompatibleProvider({
      api_key: 'sk-test',
      model: 'gpt-4',
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4',
      stream: true,
      on_chunk: (c) => chunks.push(c),
    });

    // 拼装结果
    expect(response.content).toBe('Hello world');
    expect(response.finish_reason).toBe('stop');
    expect(response.usage?.total_tokens).toBe(7);

    // chunk 流
    const textDeltas = chunks.filter((c) => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]?.delta).toBe('Hello');
    expect(textDeltas[1]?.delta).toBe(' world');
    expect(chunks[chunks.length - 1]?.type).toBe('finish');
  });

  it('should accumulate streamed tool_calls by index into complete arguments', async () => {
    mockFetchSse([
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Beijing\\"}"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const provider = new OpenAICompatibleProvider({
      api_key: 'sk-test',
      model: 'gpt-4',
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'weather?' }],
      model: 'gpt-4',
      stream: true,
      on_chunk: (c) => chunks.push(c),
    });

    expect(response.finish_reason).toBe('tool_calls');
    expect(response.tool_calls).toHaveLength(1);
    const tc = response.tool_calls?.[0];
    expect(tc?.id).toBe('call_1');
    expect(tc?.function.name).toBe('get_weather');
    // 累积的 arguments 必须是合法 JSON
    expect(JSON.parse(tc?.function.arguments ?? '{}')).toEqual({ city: 'Beijing' });

    // 首片含 id+name，后续片仅 arguments_delta
    const tcChunks = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(tcChunks[0]?.tool_call_id).toBe('call_1');
    expect(tcChunks[0]?.tool_call_name).toBe('get_weather');
    const reassembledArgs = tcChunks.map((c) => c.arguments_delta ?? '').join('');
    expect(reassembledArgs).toBe('{"city":"Beijing"}');
  });

  it('should fall back to non-stream path when on_chunk absent', async () => {
    // 非流式走既有 JSON 整段路径：mock 返回普通 JSON（非 SSE）
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: 'plain answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({ api_key: 'sk-test', model: 'gpt-4' });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4',
    });

    expect(response.content).toBe('plain answer');
    expect(response.finish_reason).toBe('stop');
  });
});
