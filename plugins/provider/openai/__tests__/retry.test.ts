/**
 * provider 重试：瞬时错误重试、永久错误直通、abort 与流式输出后不重试。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost } from '@vessel-agent/core';
import plugin, { type ProviderPluginOptions } from '../src/index';
import { isRetryableError, withRetry } from '../src/retry';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK = { content: 'ok', finish_reason: 'stop' as const };

function sequencedProvider(errors: Error[]): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      async chat() {
        calls += 1;
        const error = errors[calls - 1];
        if (error) throw error;
        return OK;
      },
    },
    calls: () => calls,
  };
}

describe('withRetry', () => {
  it('429 两次后成功，退避按 base*2^n 递增', async () => {
    const { provider, calls } = sequencedProvider([
      new Error('OpenAI API error: 429 - slow down'),
      new Error('OpenAI API error: 429 - slow down'),
    ]);
    const delays: number[] = [];
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      jitter: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(wrapped.chat({ messages: [], model: 'm' })).resolves.toEqual(OK);
    expect(calls()).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('429 优先按 retryAfterMs 退避，且不超过 maxDelayMs', async () => {
    const capped = Object.assign(new Error('OpenAI API error: 429 - slow down'), {
      status: 429,
      retryAfterMs: 5000,
    });
    const snake = Object.assign(new Error('OpenAI API error: 429 - slow down'), {
      status: 429,
      retry_after_ms: 7,
    });
    const { provider, calls } = sequencedProvider([capped, snake]);
    const delays: number[] = [];
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      jitter: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(wrapped.chat({ messages: [], model: 'm' })).resolves.toEqual(OK);
    expect(calls()).toBe(3);
    // 首次 5000 被 maxDelayMs 截断；第二次按秒级 snake 字段的毫秒值 7
    expect(delays).toEqual([1000, 7]);
  });

  it('429 缺结构化退避字段时读取 retry-after 头（秒）', async () => {
    const error = Object.assign(new Error('OpenAI API error: 429 - slow down'), {
      status: 429,
      headers: { 'retry-after': '2' },
    });
    const { provider } = sequencedProvider([error]);
    const delays: number[] = [];
    const wrapped = withRetry(provider, {
      maxRetries: 1,
      baseDelayMs: 10,
      jitter: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await wrapped.chat({ messages: [], model: 'm' });
    expect(delays).toEqual([2000]);
  });

  it('402 额度耗尽不重试', async () => {
    const quota = Object.assign(new Error('OpenAI API error: 402 - quota exceeded'), {
      status: 402,
    });
    expect(isRetryableError(quota)).toBe(false);
    const { provider, calls } = sequencedProvider([quota]);
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });

    await expect(wrapped.chat({ messages: [], model: 'm' })).rejects.toThrow(/quota exceeded/);
    expect(calls()).toBe(1);
  });

  it('503 不采用 retry-after，仍按指数退避', async () => {
    const error = Object.assign(new Error('OpenAI API error: 503 - busy'), {
      status: 503,
      retryAfterMs: 60_000,
    });
    const { provider } = sequencedProvider([error, error]);
    const delays: number[] = [];
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await wrapped.chat({ messages: [], model: 'm' });
    expect(delays).toEqual([10, 20]);
  });

  it('401 不重试', async () => {
    const { provider, calls } = sequencedProvider([new Error('OpenAI API error: 401 - bad key')]);
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });
    await expect(wrapped.chat({ messages: [], model: 'm' })).rejects.toThrow(/401/);
    expect(calls()).toBe(1);
  });

  it('重试耗尽后抛出最后一次错误', async () => {
    const { provider, calls } = sequencedProvider([
      new Error('OpenAI API error: 500 - one'),
      new Error('OpenAI API error: 500 - two'),
      new Error('OpenAI API error: 500 - three'),
    ]);
    const wrapped = withRetry(provider, {
      maxRetries: 2,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });
    await expect(wrapped.chat({ messages: [], model: 'm' })).rejects.toThrow(/three/);
    expect(calls()).toBe(3);
  });

  it('调用方 abort 后不再重试', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        controller.abort(new Error('user cancelled'));
        throw new Error('OpenAI API error: 429 - slow down');
      },
    };
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });

    await expect(
      wrapped.chat({ messages: [], model: 'm', signal: controller.signal }),
    ).rejects.toThrow(/user cancelled/);
    expect(calls).toBe(1);
  });

  it('流式已输出内容后遇到网络错误不重试（避免重复文本）', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async chat(req) {
        calls += 1;
        req.on_chunk?.({ type: 'text_delta', delta: 'partial' });
        throw new Error('fetch failed');
      },
    };
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });

    await expect(
      wrapped.chat({
        messages: [],
        model: 'm',
        stream: true,
        on_chunk: () => {},
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(1);
  });

  it('网络类错误可重试，且 maxRetries <= 0 时返回原 provider', async () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('connect ECONNRESET 1.2.3.4:443'))).toBe(true);
    expect(isRetryableError(new Error('OpenAI API error: 400 - bad request'))).toBe(false);

    const { provider, calls } = sequencedProvider([new Error('Network error: reset')]);
    const off = withRetry(provider, { maxRetries: 0 });
    expect(off).toBe(provider);
    await expect(off.chat({ messages: [], model: 'm' })).rejects.toThrow(/reset/);
    expect(calls()).toBe(1);
  });

  it('onRetry 记录每次重试的 attempt / delay / status', async () => {
    const { provider } = sequencedProvider([
      new Error('OpenAI API error: 429 - slow down'),
      new Error('OpenAI API error: 503 - busy'),
    ]);
    const events: Array<{
      attempt: number;
      delayMs: number;
      status?: number;
      errorName: string;
      provider?: string;
    }> = [];

    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 5,
      jitter: 0,
      sleep: async () => {},
      provider: 'openai',
      onRetry: (event) => events.push(event),
    });

    await wrapped.chat({ messages: [], model: 'm' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      attempt: 1,
      delayMs: 5,
      status: 429,
      errorName: 'Error',
      provider: 'openai',
    });
    expect(events[1]).toMatchObject({ attempt: 2, delayMs: 10, status: 503 });
  });

  it('未注入 onRetry 时写结构化 stderr，且不含错误正文', async () => {
    const { provider } = sequencedProvider([
      new Error('OpenAI API error: 429 - slow down sk-abcdefghijklmnop'),
    ]);
    const lines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const wrapped = withRetry(provider, {
        maxRetries: 1,
        baseDelayMs: 1,
        jitter: 0,
        sleep: async () => {},
      });
      await wrapped.chat({ messages: [], model: 'm' });
    } finally {
      process.stderr.write = originalWrite;
    }

    const line = lines.find((entry) => entry.includes('provider retry'));
    if (line === undefined) throw new Error('retry log line not found');
    expect(JSON.parse(line)).toMatchObject({
      level: 'warn',
      message: 'provider retry',
      fields: { attempt: 1, status: 429, error_name: 'Error' },
    });
    expect(line).not.toContain('abcdefghijklmnop');
  });
});

describe('provider-openai 插件装配重试', () => {
  function installWithConfig(config: Record<string, unknown>): MemoryPluginHost {
    const host = new MemoryPluginHost();
    (plugin.install as (host: MemoryPluginHost, options?: ProviderPluginOptions) => void)(host, {
      config,
    });
    return host;
  }

  it('install 级配置可开启重试并覆盖默认值', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests < 3) return new Response('busy', { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const host = installWithConfig({
      timeout_ms: 0,
      max_retries: 3,
      retry_base_delay_ms: 1,
      retry_jitter: 0,
    });
    const provider = host.getProvider('openai')?.({ api_key: 'k', timeout_ms: 0 });
    if (!provider) throw new Error('provider not registered');

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).resolves.toMatchObject({ content: 'ok' });
    expect(requests).toBe(3);
  });

  it('程序化 config.onRetry 注入到重试层，并带 provider 名', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return new Response('busy', { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const events: Array<Record<string, unknown>> = [];
    const host = installWithConfig({
      timeout_ms: 0,
      max_retries: 2,
      retry_base_delay_ms: 1,
      retry_jitter: 0,
      onRetry: (event: Record<string, unknown>) => events.push(event),
    });
    const provider = host.getProvider('openai')?.({ api_key: 'k', timeout_ms: 0 });
    if (!provider) throw new Error('provider not registered');

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attempt: 1, status: 503, provider: 'openai' });
  });
});
