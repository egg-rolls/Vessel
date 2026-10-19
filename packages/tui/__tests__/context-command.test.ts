import { describe, expect, it } from 'bun:test';
import type { ContextManager, Message } from '@vessel/core';
import {
  compactSessionContext,
  estimateContextUsage,
  estimateTokens,
  formatContextReport,
} from '../src/commands/context-command.js';

describe('estimateContextUsage', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      ],
    },
    { role: 'tool', content: 'a.txt\nb.txt', tool_call_id: 'c1', name: 'bash' },
  ];

  it('system / 对话 / 工具结果分开计费（混在一起会让用户误判压缩收益）', () => {
    const usage = estimateContextUsage(messages, { maxTokens: 1000, autoCompact: true });
    expect(usage.system.count).toBe(1);
    expect(usage.messages.count).toBe(2);
    expect(usage.toolResults.count).toBe(1);
    expect(usage.system.tokens).toBe(estimateTokens('system prompt'));
    expect(usage.toolResults.tokens).toBe(estimateTokens('a.txt\nb.txt'));
    // assistant 的 tool_call 参数计入对话消息
    expect(usage.messages.tokens).toBeGreaterThan(
      estimateTokens('hello') + estimateTokens('calling tool'),
    );
    expect(usage.totalTokens).toBe(
      usage.system.tokens + usage.messages.tokens + usage.toolResults.tokens,
    );
  });

  it('CJK 按 0.5 token/字符估算（ASCII 0.25）', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('中文')).toBe(1);
    expect(estimateTokens('中a')).toBe(1);
  });

  it('报告包含总量、百分比与 auto-compact 阈值', () => {
    const usage = estimateContextUsage(messages, {
      maxTokens: 100,
      threshold: 0.5,
      autoCompact: true,
    });
    const report = formatContextReport(usage);
    expect(report).toContain(`/ 100 tokens`);
    expect(report).toContain('auto-compact: on at 50% (50 tokens)');
    expect(report).toContain('tool results');
  });
});

function fakeContext(
  messages: Message[],
  overrides: Partial<ContextManager> & Record<string, unknown> = {},
): ContextManager {
  return {
    add() {},
    messages,
    compact: () => 0,
    clear() {},
    tokenCount: 0,
    setSessionId() {},
    getSessionId: () => 's',
    updateRealTokens() {},
    ...overrides,
  } as ContextManager;
}

describe('compactSessionContext', () => {
  it('优先 compactAsync，并把压缩后的 messages 交给持久化', async () => {
    const after: Message[] = [{ role: 'assistant', content: 'summary' }];
    const context = fakeContext(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      {
        compactAsync: async () => 2,
        messages: after,
      },
    );

    let persisted: Message[] | undefined;
    const outcome = await compactSessionContext(context, async (messages) => {
      persisted = messages;
      return true;
    });

    expect(outcome).toEqual({ removed: 2, remaining: 1, mode: 'async', persisted: true });
    expect(persisted).toEqual(after);
  });

  it('旧 core 只有同步 compact 时仍可工作，并标记 sync 模式', async () => {
    const context = fakeContext([{ role: 'user', content: 'a' }], { compact: () => 1 });
    const outcome = await compactSessionContext(context);
    expect(outcome.mode).toBe('sync');
    expect(outcome.removed).toBe(1);
    expect(outcome.persisted).toBe(false);
  });

  it('持久化失败不吞掉压缩结果（removed 仍返回）', async () => {
    const context = fakeContext([{ role: 'user', content: 'a' }], {
      compactAsync: async () => 1,
    });
    const outcome = await compactSessionContext(context, async () => {
      throw new Error('disk full');
    });
    expect(outcome.removed).toBe(1);
    expect(outcome.persisted).toBe(false);
  });
});
