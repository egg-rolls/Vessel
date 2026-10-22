/**
 * 未注册 provider fallback：有 openai 工厂时复用 withRetry/withTimeout；
 * 无工厂（损坏安装）时保留裸 OpenAICompatibleProvider。
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { OpenAICompatibleProvider } from '../../packages/core/src/index';
import { createProvider, resetUnknownProviderNotice } from '../provider-factory';

const realFetch = globalThis.fetch;

const OPENAI_LOADER = {
  getProviders: () => ['provider-openai'],
  load: async () => (await import('../../plugins/provider/openai/src/index')).default,
};

const EMPTY_LOADER = {
  getProviders: () => [] as string[],
  load: async () => null,
};

describe('未注册 provider fallback', () => {
  beforeEach(() => {
    resetUnknownProviderNotice();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetUnknownProviderNotice();
  });

  it('复用 openai 工厂：fallback 受 timeout 约束（provider_timeout）', async () => {
    // 延迟 200ms 返回合法 200；若 fallback 绕过 withTimeout 会正常返回，测试失败。
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: 'late' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }, 200);
        init?.signal?.addEventListener('abort', () => clearTimeout(timer));
      })) as unknown as typeof fetch;

    const { provider } = await createProvider(
      {
        provider: {
          name: 'custom-endpoint',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
          timeoutMs: 50,
        },
      },
      OPENAI_LOADER,
      false,
    );

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' }),
    ).rejects.toMatchObject({ code: 'provider_timeout' });
  });

  it('openai 工厂缺失时仍返回裸 OpenAICompatibleProvider，不抛错', async () => {
    const { provider } = await createProvider(
      {
        provider: {
          name: 'custom-endpoint',
          model: 'test-model',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
      },
      EMPTY_LOADER,
      false,
    );

    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
