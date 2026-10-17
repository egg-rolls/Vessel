/**
 * provider-openai 契约测试。
 *
 * 只测插件面：5 个注册名、各自默认 base_url/model、空 base_url 与尾斜杠、
 * 经工厂的请求形状、流式 tool_calls 累积、错误与超时。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost, type Message } from '@vessel/core';
import plugin from '../src/index';
import { withTimeout } from '../src/timeout';

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function factoryFor(name: string): (config: Record<string, unknown>) => LLMProvider {
  const host = new MemoryPluginHost();
  plugin.install(host);
  const factory = host.getProvider(name);
  if (!factory) throw new Error(`provider not registered: ${name}`);
  return factory;
}

function mockJson(payload: unknown, captured: Captured[] = []): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function mockSse(chunks: string[]): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => {
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
  choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('provider-openai 注册与默认值', () => {
  it('注册 5 个 OpenAI 兼容 provider', () => {
    const host = new MemoryPluginHost();
    plugin.install(host);
    expect(host.listProviders().sort()).toEqual(
      ['cohere', 'google', 'mistral', 'ollama', 'openai'].sort(),
    );
  });

  it('每个 provider 在 base_url 缺省/空字符串时回落到自己的默认端点', async () => {
    const expected: Record<string, string> = {
      openai: 'https://api.openai.com/v1/chat/completions',
      google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      ollama: 'http://localhost:11434/v1/chat/completions',
      cohere: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    };

    for (const [name, url] of Object.entries(expected)) {
      for (const baseUrl of [undefined, '']) {
        const captured: Captured[] = [];
        mockJson(TEXT_RESPONSE, captured);
        const provider = factoryFor(name)({ api_key: 'k', base_url: baseUrl, timeout_ms: 0 });
        await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
        expect(captured[0]?.url).toBe(url);
      }
    }
  });

  it('显式 base_url 优先且尾斜杠归一；temperature / max_tokens 透传', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor('openai')({
      api_key: 'k',
      base_url: 'https://proxy.example.com/v1/',
      temperature: 0.2,
      max_tokens: 123,
      timeout_ms: 0,
    });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });

    expect(captured[0]?.url).toBe('https://proxy.example.com/v1/chat/completions');
    expect(captured[0]?.body.temperature).toBe(0.2);
    expect(captured[0]?.body.max_tokens).toBe(123);
    expect(captured[0]?.headers.authorization).toBe('Bearer k');
  });

  it('model 缺省时用各 provider 的默认值，显式值优先', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const factory = factoryFor('ollama');

    await factory({ api_key: '', timeout_ms: 0 }).chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: undefined as never,
    });
    await factory({ api_key: '', model: 'custom', timeout_ms: 0 }).chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'custom',
    });

    expect(captured[0]?.body.model).toBe('llama3');
    expect(captured[1]?.body.model).toBe('custom');
  });
});

describe('provider-openai 请求形状', () => {
  it('assistant tool_calls / role:tool 映射，流式请求带 include_usage', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor('openai')({ api_key: 'k', timeout_ms: 0 });

    const messages: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'sunny' },
    ];

    await provider.chat({
      messages,
      model: 'gpt-4',
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: {} },
        },
      ],
    });

    const sent = captured[0]?.body.messages as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(sent[1]).toEqual({ role: 'user', content: 'weather?' });
    expect(sent[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
        },
      ],
    });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'sunny' });
    expect(captured[0]?.body.stream).toBe(false);
  });

  it('流式：stream_options.include_usage + tool_calls 按 index 累积', async () => {
    mockSse([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"echo","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n`,
      'data: [DONE]\n\n',
    ]);

    let sentBody: Record<string, unknown> = {};
    const provider = factoryFor('openai')({ api_key: 'k', timeout_ms: 0 });
    // 复用 SSE mock 的同时捕获请求体
    const sseFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return sseFetch(input, init);
    }) as unknown as typeof fetch;

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'echo' }],
      model: 'gpt-4',
      stream: true,
      on_chunk: () => undefined,
    });

    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(response.finish_reason).toBe('tool_calls');
    expect(JSON.parse(response.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ x: 1 });
    expect(response.usage?.total_tokens).toBe(6);
  });
});

describe('provider-openai 错误与超时', () => {
  it('HTTP 非 2xx 抛出带状态码与 body 的错误', async () => {
    globalThis.fetch = (async () =>
      new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const provider = factoryFor('openai')({ api_key: 'k', timeout_ms: 0 });

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(/401.*bad key/);
  });

  it('超过 timeout_ms 时拒绝并中断底层请求', async () => {
    let aborted = false;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof fetch;

    const provider = factoryFor('openai')({ api_key: 'k', timeout_ms: 25 });
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(/timed out after 25ms/);
    expect(aborted).toBe(true);
  });

  it('withTimeout 在 timeoutMs <= 0 时返回原 provider', () => {
    const inner: LLMProvider = { chat: async () => ({ content: '', finish_reason: 'stop' }) };
    expect(withTimeout(inner, 0)).toBe(inner);
  });
});
