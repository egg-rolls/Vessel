/**
 * provider 重试：瞬时错误重试、永久错误直通、abort 与流式输出后不重试。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost } from '@vessel/core';
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
});
