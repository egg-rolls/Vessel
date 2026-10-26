/**
 * Anthropic 显式提示词缓存：请求断点与 usage 缓存字段映射。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost } from '@vessel-agent/core';
import plugin from '../src/index';

const realFetch = globalThis.fetch;

interface Captured {
  body: Record<string, unknown>;
}

function factoryFor(): (config: Record<string, unknown>) => LLMProvider {
  const host = new MemoryPluginHost();
  plugin.install(host);
  const factory = host.getProvider('anthropic');
  if (!factory) throw new Error('provider not registered: anthropic');
  return factory;
}

function mockJson(payload: unknown, captured: Captured[] = []): void {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function mockSse(chunks: string[], captured: Captured[] = []): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

const TEXT_RESPONSE = {
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 2 },
};

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_time',
      description: 'time',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const MINIMAL_SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Anthropic 显式提示词缓存断点', () => {
  it('默认开启：system / 最后一个 tool / 最后一条消息的 text block 带 cache_control', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    await provider.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      model: 'claude-test',
      tools: TOOLS,
    });

    const body = captured[0]?.body;
    expect(body?.system).toEqual([
      { type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } },
    ]);

    const tools = body?.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' });

    const sent = body?.messages as Array<{ content: unknown }>;
    expect(sent[sent.length - 1]?.content).toEqual([
      { type: 'text', text: 'weather?', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('流式请求体使用同一套断点', async () => {
    const captured: Captured[] = [];
    mockSse(MINIMAL_SSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    await provider.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      model: 'claude-test',
      tools: TOOLS,
      stream: true,
      on_chunk: () => undefined,
    });

    const body = captured[0]?.body;
    expect(body?.stream).toBe(true);
    expect(body?.system).toEqual([
      { type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } },
    ]);
    const tools = body?.tools as Array<Record<string, unknown>>;
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' });
    const sent = body?.messages as Array<{ content: unknown }>;
    expect(sent[sent.length - 1]?.content).toEqual([
      { type: 'text', text: 'weather?', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('最后一条消息为 block 数组时给最后一个可缓存 block 加断点', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    await provider.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'sunny' },
      ],
      model: 'claude-test',
    });

    const sent = captured[0]?.body.messages as Array<{ content: unknown }>;
    expect(sent[sent.length - 1]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tc1',
        content: 'sunny',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // 断点只落在最后一条消息；之前的 assistant tool_use 不加
    expect(sent[sent.length - 2]?.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'tc1', name: 'get_weather', input: {} },
    ]);
  });

  it('最后一条消息没有可缓存 block 时跳过消息断点', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    await provider.chat({
      messages: [{ role: 'user', content: '' }],
      model: 'claude-test',
    });

    const sent = captured[0]?.body.messages as Array<{ content: unknown }>;
    expect(sent[0]?.content).toBe('');
  });
});

describe('Anthropic 显式提示词缓存关闭', () => {
  it('prompt_cache false：不发 cache_control，system 保持字符串', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0, prompt_cache: false });

    await provider.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ],
      model: 'claude-test',
      tools: TOOLS,
    });

    const body = captured[0]?.body;
    expect(body?.system).toBe('be brief');
    expect(JSON.stringify(body)).not.toContain('cache_control');

    const sent = body?.messages as Array<{ content: unknown }>;
    expect(sent[0]?.content).toBe('weather?');
  });

  it('程序化注入的 promptCache false 同样生效', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0, promptCache: false });

    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      tools: TOOLS,
    });

    expect(JSON.stringify(captured[0]?.body)).not.toContain('cache_control');
  });
});

describe('Anthropic usage 缓存字段', () => {
  const CACHED_USAGE = {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 3,
  };
  const expectedUsage = {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 3,
  };

  it('非流式响应映射 cache_creation_input_tokens / cache_read_input_tokens', async () => {
    mockJson({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: CACHED_USAGE,
    });
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
    });

    expect(response.usage).toEqual(expectedUsage);
  });

  it('流式响应（含 finish chunk）映射缓存字段', async () => {
    mockSse([
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":7,"cache_read_input_tokens":3}}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });
    let finishUsage: unknown;

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      stream: true,
      on_chunk: (chunk) => {
        if (chunk.type === 'finish') finishUsage = chunk.usage;
      },
    });

    expect(response.usage).toEqual(expectedUsage);
    expect(finishUsage).toEqual(expectedUsage);
  });
});
