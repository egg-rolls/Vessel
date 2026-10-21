import { describe, expect, it } from 'bun:test';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../../packages/core/src/index';
import { createContextSummarizer } from '../tenant-runtime-factory';

interface FakeProvider {
  provider: LLMProvider;
  calls: ChatRequest[];
}

function scriptedProvider(
  reply: (call: ChatRequest, index: number) => string | Error,
): FakeProvider {
  const calls: ChatRequest[] = [];
  const provider: LLMProvider = {
    async chat(request: ChatRequest): Promise<LLMResponse> {
      calls.push(request);
      const result = reply(request, calls.length - 1);
      if (result instanceof Error) throw result;
      return { content: result, finish_reason: 'stop' };
    },
  };
  return { provider, calls };
}

function userText(call: ChatRequest | undefined): string {
  return call?.messages[1]?.content ?? '';
}

/** 每块 9,000 ASCII 字符 ≈ 2,250 token，超过最小块预算 2,000。 */
const LARGE_CHUNK_CHARS = 9_000;

function largeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: `MSG-${index} ${'a'.repeat(LARGE_CHUNK_CHARS)}`,
  }));
}

describe('createContextSummarizer（0.14.4 分块与工具调用）', () => {
  it('工具调用名称/参数与工具结果丢失时摘要不可用', async () => {
    const { provider, calls } = scriptedProvider(() => 'summary');
    const result = await createContextSummarizer(provider, 'm')(
      [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: 'reading it',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"src/a.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      ],
      { maxTokens: 1_000_000 },
    );

    expect(result).toBe('summary');
    expect(calls).toHaveLength(1);
    const transcript = userText(calls[0]);
    expect(transcript).toContain('[assistant] reading it');
    expect(transcript).toContain('[tool_call:read] {"path":"src/a.ts"}');
    expect(transcript).toContain('[tool:call_1] file body');
  });

  it('单块上下文被分块或多次调用时产生多余摘要请求', async () => {
    const { provider, calls } = scriptedProvider(() => 'one summary');
    const result = await createContextSummarizer(provider, 'm')(
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 100_000 },
    );

    expect(result).toBe('one summary');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.max_tokens).toBe(2048);
  });

  it('多块上下文漏掉后半段时只摘要了第一块', async () => {
    const { provider, calls } = scriptedProvider((_call, index) =>
      index < 3 ? `partial-${index + 1}` : 'final summary',
    );
    const result = await createContextSummarizer(provider, 'm')(largeMessages(3), {
      maxTokens: 16_000,
    });

    expect(result).toBe('final summary');
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 3).map((call) => call.max_tokens)).toEqual([1024, 1024, 1024]);
    expect(calls[3]?.max_tokens).toBe(2048);
    expect(userText(calls[0])).toContain('MSG-0');
    expect(userText(calls[0])).not.toContain('MSG-1');
    expect(userText(calls[1])).toContain('MSG-1');
    expect(userText(calls[2])).toContain('MSG-2');
    expect(userText(calls[3])).toContain('partial-1');
    expect(userText(calls[3])).toContain('partial-3');
  });

  it('单个分块失败时整段摘要被丢弃', async () => {
    const { provider, calls } = scriptedProvider((_call, index) => {
      if (index === 1) return new Error('chunk down');
      if (index === 3) return 'final summary';
      return `partial-${index + 1}`;
    });
    const result = await createContextSummarizer(provider, 'm')(largeMessages(3), {
      maxTokens: 16_000,
    });

    expect(result).toBe('final summary');
    expect(calls).toHaveLength(4);
    const reduceInput = userText(calls[3]);
    expect(reduceInput).toContain('partial-1');
    expect(reduceInput).toContain('[partial summary unavailable: chunk 2]');
    expect(reduceInput).toContain('partial-3');
  });

  it('reduce 失败时部分摘要被丢弃（返回空）', async () => {
    const { provider } = scriptedProvider((_call, index) =>
      index === 3 ? new Error('reduce down') : `partial-${index + 1}`,
    );
    const result = await createContextSummarizer(provider, 'm')(largeMessages(3), {
      maxTokens: 16_000,
    });

    expect(result).toBe('partial-1\n\npartial-2\n\npartial-3');
  });

  it('全部失败时返回非空串（core 误以为摘要有效）', async () => {
    const { provider, calls } = scriptedProvider(() => new Error('provider down'));
    const result = await createContextSummarizer(provider, 'm')(largeMessages(3), {
      maxTokens: 16_000,
    });

    expect(result).toBe('');
    expect(calls).toHaveLength(3);
  });

  it('单条超长未截断或 reasoning 混入摘要', async () => {
    const { provider, calls } = scriptedProvider(() => 'summary');
    await createContextSummarizer(provider, 'm')(
      [
        { role: 'user', content: 'x'.repeat(20_000) },
        {
          role: 'assistant',
          content: 'done',
          reasoning_content: 'SECRET-REASONING',
        },
      ],
      { maxTokens: 1_000_000 },
    );

    const transcript = userText(calls[0]);
    expect(transcript).toContain('[truncated]');
    const kept = (transcript.match(/x/g) ?? []).length;
    expect(kept).toBeLessThanOrEqual(12_000);
    expect(kept).toBeGreaterThan(11_000);
    expect(transcript).toContain('[assistant] done');
    expect(transcript).not.toContain('SECRET-REASONING');
  });
});
