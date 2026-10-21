/**
 * provider-anthropic 重试：429/5xx 重试、4xx 直通、abort 立即停止。
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

describe('withRetry (anthropic)', () => {
  it('5xx 重试后成功', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        if (calls < 3) throw new Error('Anthropic API error: 529 - overloaded');
        return OK;
      },
    };
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });

    await expect(wrapped.chat({ messages: [], model: 'm' })).resolves.toEqual(OK);
    expect(calls).toBe(3);
  });

  it('429 优先按 retryAfterMs 退避，且不超过 maxDelayMs', async () => {
    const capped = Object.assign(new Error('Anthropic API error: 429 - rate limited'), {
      status: 429,
      retryAfterMs: 5000,
    });
    const snake = Object.assign(new Error('Anthropic API error: 429 - rate limited'), {
      status: 429,
      retry_after_ms: 7,
    });
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        const error = calls === 1 ? capped : calls === 2 ? snake : undefined;
        if (error) throw error;
        return OK;
      },
    };
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
    expect(calls).toBe(3);
    // 首次 5000 被 maxDelayMs 截断；第二次按秒级 snake 字段的毫秒值 7
    expect(delays).toEqual([1000, 7]);
  });

  it('429 缺结构化退避字段时读取 retry-after 头（秒）', async () => {
    const error = Object.assign(new Error('Anthropic API error: 429 - rate limited'), {
      status: 429,
      headers: { 'retry-after': '2' },
    });
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        if (calls === 1) throw error;
        return OK;
      },
    };
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
    const quota = Object.assign(new Error('Anthropic API error: 402 - quota exceeded'), {
      status: 402,
    });
    expect(isRetryableError(quota)).toBe(false);
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        throw quota;
      },
    };
    const wrapped = withRetry(provider, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: 0,
      sleep: async () => {},
    });

    await expect(wrapped.chat({ messages: [], model: 'm' })).rejects.toThrow(/quota exceeded/);
    expect(calls).toBe(1);
  });

  it('503 不采用 retry-after，仍按指数退避', async () => {
    const error = Object.assign(new Error('Anthropic API error: 503 - unavailable'), {
      status: 503,
      retryAfterMs: 60_000,
    });
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        if (calls <= 2) throw error;
        return OK;
      },
    };
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

  it('abort 后停止重试并抛出 abort 原因', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        controller.abort(new Error('user cancelled'));
        throw new Error('Anthropic API error: 500 - boom');
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

  it('onRetry 记录每次重试的 attempt / delay / status', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        if (calls === 1) throw new Error('Anthropic API error: 429 - rate limited');
        if (calls === 2) throw new Error('Anthropic API error: 503 - unavailable');
        return OK;
      },
    };
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
      provider: 'anthropic',
      onRetry: (event) => events.push(event),
    });

    await wrapped.chat({ messages: [], model: 'm' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      attempt: 1,
      delayMs: 5,
      status: 429,
      errorName: 'Error',
      provider: 'anthropic',
    });
    expect(events[1]).toMatchObject({ attempt: 2, delayMs: 10, status: 503 });
  });

  it('未注入 onRetry 时写结构化 stderr，且不含错误正文', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          throw new Error('Anthropic API error: 529 - overloaded sk-abcdefghijklmnop');
        }
        return OK;
      },
    };
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
      fields: { attempt: 1, status: 529, error_name: 'Error' },
    });
    expect(line).not.toContain('abcdefghijklmnop');
  });
});

describe('provider-anthropic 插件装配重试', () => {
  it('429 两次后成功；请求总数为 3', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests < 3) return new Response('rate limited', { status: 429 });
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const host = new MemoryPluginHost();
    (plugin.install as (host: MemoryPluginHost, options?: ProviderPluginOptions) => void)(host, {
      config: { timeout_ms: 0, max_retries: 3, retry_base_delay_ms: 1, retry_jitter: 0 },
    });
    const provider = host.getProvider('anthropic')?.({ api_key: 'k', timeout_ms: 0 });
    if (!provider) throw new Error('provider not registered');

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).resolves.toMatchObject({ content: 'ok' });
    expect(requests).toBe(3);
  });
});
