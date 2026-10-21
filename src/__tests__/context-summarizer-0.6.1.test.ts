import { describe, expect, it } from 'bun:test';
import type { ChatRequest, LLMProvider, LLMResponse } from '../../packages/core/src/index';
import { createContextSummarizer } from '../tenant-runtime-factory';

function fakeProvider(content = 'summary text'): {
  provider: LLMProvider;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  const provider: LLMProvider = {
    async chat(request: ChatRequest): Promise<LLMResponse> {
      calls.push(request);
      return { content, finish_reason: 'stop' };
    },
  };
  return { provider, calls };
}

describe('createContextSummarizer（0.6.1 E3）', () => {
  it('用当前 provider/model 生成摘要', async () => {
    const { provider, calls } = fakeProvider('kept decisions');
    const summarize = createContextSummarizer(provider, 'model-x');

    const result = await summarize(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      { maxTokens: 500 },
    );

    expect(result).toBe('kept decisions');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('model-x');
    expect(calls[0]?.max_tokens).toBe(500);
    expect(calls[0]?.temperature).toBe(0);
    const prompt = JSON.stringify(calls[0]?.messages);
    expect(prompt).toContain('hello');
    expect(prompt).toContain('hi');
  });

  it('摘要 token 预算夹在 128..2048', async () => {
    const small = fakeProvider();
    await createContextSummarizer(small.provider, 'm')([{ role: 'user', content: 'x' }], {
      maxTokens: 10,
    });
    expect(small.calls[0]?.max_tokens).toBe(128);

    const large = fakeProvider();
    await createContextSummarizer(large.provider, 'm')([{ role: 'user', content: 'x' }], {
      maxTokens: 100_000,
    });
    expect(large.calls[0]?.max_tokens).toBe(2048);
  });
});
