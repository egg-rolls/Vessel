/**
 * provider-anthropic 契约测试。
 *
 * 只测插件面：注册、配置映射（默认值/空 base_url/尾斜杠）、经工厂的请求形状、
 * 流式响应、错误与超时。具体解析细节归 core 的 provider 测试。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost, type Message } from '@vessel-agent/core';
import plugin from '../src/index';
import { DEFAULT_TIMEOUT_MS, resolveTimeoutMs, withTimeout } from '../src/timeout';

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

/** 安装插件并取工厂 */
function factoryFor(name = 'anthropic'): (config: Record<string, unknown>) => LLMProvider {
  const host = new MemoryPluginHost();
  plugin.install(host);
  const factory = host.getProvider(name);
  if (!factory) throw new Error(`provider not registered: ${name}`);
  return factory;
}

/** 默认 200 JSON 响应（非流式） */
function mockJson(payload: unknown, captured: Captured[] = []): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal ?? undefined,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** 默认 200 SSE 响应 */
function mockSse(chunks: string[], captured: Captured[] = []): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal ?? undefined,
    });
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('provider-anthropic 注册与默认值', () => {
  it('注册 anthropic 工厂', () => {
    const host = new MemoryPluginHost();
    plugin.install(host);
    expect(host.listProviders()).toEqual(['anthropic']);
  });

  it('base_url 缺省或空字符串时回落到默认端点；尾斜杠归一', async () => {
    for (const baseUrl of [undefined, '', 'https://proxy.example.com/']) {
      const captured: Captured[] = [];
      mockJson(TEXT_RESPONSE, captured);
      const provider = factoryFor()({
        api_key: 'sk-ant-test',
        base_url: baseUrl,
        model: 'claude-test',
        timeout_ms: 0,
      });
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-test' });

      const expected =
        baseUrl === 'https://proxy.example.com/'
          ? 'https://proxy.example.com/v1/messages'
          : 'https://api.anthropic.com/v1/messages';
      expect(captured[0]?.url).toBe(expected);
      expect(captured[0]?.headers['x-api-key']).toBe('sk-ant-test');
      expect(captured[0]?.headers['anthropic-version']).toBe('2023-06-01');
    }
  });

  it('model 缺省时用工厂默认值，显式值优先', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const factory = factoryFor();

    await factory({
      api_key: 'k',
      timeout_ms: 0,
    }).chat({ messages: [{ role: 'user', content: 'hi' }], model: undefined as never });
    await factory({
      api_key: 'k',
      model: 'claude-custom',
      timeout_ms: 0,
    }).chat({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-custom' });

    expect(captured[0]?.body.model).toBe('claude-3-opus-20240229');
    expect(captured[1]?.body.model).toBe('claude-custom');
  });
});

describe('provider-anthropic 请求形状', () => {
  it('system 抽取、tools input_schema、tool_result / tool_use 映射', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });

    const messages: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
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
      model: 'claude-test',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });

    const body = captured[0]?.body;
    expect(body?.system).toBe('be brief');
    expect(body?.tools).toEqual([
      {
        name: 'get_weather',
        description: 'weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);

    const sent = body?.messages as Array<{ role: string; content: unknown }>;
    expect(sent[0]).toEqual({ role: 'user', content: 'weather?' });
    expect(sent[1]?.role).toBe('assistant');
    expect(sent[1]?.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'tc1', name: 'get_weather', input: { city: 'Beijing' } },
    ]);
    expect(sent[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'sunny' }],
    });
  });

  it('配置的 temperature / max_tokens 不会在流式或非流式请求体里被丢弃', async () => {
    const captured: Captured[] = [];
    mockJson(TEXT_RESPONSE, captured);
    const provider = factoryFor()({
      api_key: 'k',
      model: 'claude-test',
      temperature: 0.3,
      max_tokens: 321,
      timeout_ms: 0,
    });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-test' });
    expect(captured[0]?.body.temperature).toBe(0.3);
    expect(captured[0]?.body.max_tokens).toBe(321);

    mockSse(
      [
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ],
      captured,
    );
    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      stream: true,
      on_chunk: () => {},
    });
    expect(captured[1]?.body.temperature).toBe(0.3);
    expect(captured[1]?.body.max_tokens).toBe(321);
  });
});

describe('provider-anthropic 流式与错误', () => {
  it('流式 text + tool_use 拼装为完整响应', async () => {
    mockSse([
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"echo"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);

    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });
    const chunks: string[] = [];
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      stream: true,
      on_chunk: (chunk) => {
        if (chunk.type === 'text_delta') chunks.push(chunk.delta ?? '');
      },
    });

    expect(response.content).toBe('Hello');
    expect(response.finish_reason).toBe('tool_calls');
    expect(chunks.join('')).toBe('Hello');
    expect(JSON.parse(response.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ x: 1 });
  });

  it('HTTP 非 2xx 抛出带状态码与 body 的错误', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0, max_retries: 0 });

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(/429.*rate limited/);
  });

  it('超过 timeout_ms 时拒绝并中断底层请求', async () => {
    let aborted = false;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof fetch;

    const provider = factoryFor()({ api_key: 'k', timeout_ms: 25 });
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(/timed out after 25ms/);
    expect(aborted).toBe(true);
  });

  it('调用方 signal 中断会透传到 fetch', async () => {
    let received: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('caller aborted')));
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const provider = factoryFor()({ api_key: 'k', timeout_ms: 0 });
    const pending = provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(received?.aborted).toBe(true);
  });
});

describe('withTimeout', () => {
  it('timeoutMs <= 0 时直接返回原 provider', () => {
    const inner: LLMProvider = { chat: async () => ({ content: '', finish_reason: 'stop' }) };
    expect(withTimeout(inner, 0)).toBe(inner);
    expect(withTimeout(inner, -1)).toBe(inner);
  });

  it('resolveTimeoutMs：缺省/非法回落到 120s，<=0 关闭', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(resolveTimeoutMs(undefined)).toBe(120_000);
    expect(resolveTimeoutMs(Number.NaN)).toBe(120_000);
    expect(resolveTimeoutMs('25')).toBe(120_000);
    expect(resolveTimeoutMs(0)).toBe(0);
    expect(resolveTimeoutMs(-1)).toBe(0);
    expect(resolveTimeoutMs(25)).toBe(25);
  });

  it('超时抛出可识别的 ProviderTimeoutError，并用合并信号中断底层', async () => {
    let received: AbortSignal | undefined;
    const inner: LLMProvider = {
      chat(req) {
        received = req.signal;
        return new Promise<never>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(req.signal?.reason));
        });
      },
    };
    const wrapped = withTimeout(inner, 10);

    await expect(wrapped.chat({ messages: [], model: 'm' })).rejects.toMatchObject({
      name: 'ProviderTimeoutError',
      code: 'provider_timeout',
      timeoutMs: 10,
    });
    expect(received?.aborted).toBe(true);
  });

  it('调用方 abort 透传原错误，不误报为超时', async () => {
    const controller = new AbortController();
    const inner: LLMProvider = {
      chat(req) {
        return new Promise<never>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(req.signal?.reason));
        });
      },
    };
    const wrapped = withTimeout(inner, 10_000);
    const pending = wrapped.chat({ messages: [], model: 'm', signal: controller.signal });
    const reason = new Error('user cancelled');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});
