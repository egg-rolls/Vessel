/**
 * provider-anthropic 重试：429/5xx 重试、4xx 直通、abort 立即停止。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type LLMProvider, MemoryPluginHost } from '@vessel/core';
import plugin, { type ProviderPluginOptions } from '../src/index';
import { withRetry } from '../src/retry';

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
