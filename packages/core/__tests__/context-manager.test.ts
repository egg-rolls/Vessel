import { beforeEach, describe, expect, it } from 'bun:test';
import {
  estimateMessagesTokens,
  estimateMessageTokens,
  MemoryContextManager,
} from '../src/context/context-manager';

describe('MemoryContextManager', () => {
  let context: MemoryContextManager;

  beforeEach(() => {
    context = new MemoryContextManager();
  });

  it('should add and retrieve messages', () => {
    context.add({ role: 'user', content: 'Hello' });
    context.add({ role: 'assistant', content: 'Hi there!' });

    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]?.content).toBe('Hello');
    expect(context.messages[1]?.content).toBe('Hi there!');
  });

  it('should estimate token count', () => {
    context.add({ role: 'user', content: 'Hello world' });

    // 简单估算：英文字符 * 0.25
    const tokenCount = context.tokenCount;
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should clear messages', () => {
    context.add({ role: 'user', content: 'Hello' });
    context.add({ role: 'assistant', content: 'Hi!' });

    expect(context.messages).toHaveLength(2);

    context.clear();
    expect(context.messages).toHaveLength(0);
  });

  it('should compact when threshold exceeded', () => {
    const config = {
      maxTokens: 20, // 更小的 maxTokens
      autoCompact: true,
      compactThreshold: 0.5,
    };

    const contextWithCompact = new MemoryContextManager(config);

    // 添加足够多的消息触发压缩
    for (let i = 0; i < 30; i++) {
      contextWithCompact.add({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with some content`,
      });
    }

    // 消息应该被压缩
    expect(contextWithCompact.messages.length).toBeLessThan(30);
  });

  it('summarizes instead of silently slicing when maxMessages is exceeded', () => {
    const contextWithLimit = new MemoryContextManager({ maxMessages: 5 });

    for (let i = 0; i < 10; i++) {
      contextWithLimit.add({
        role: 'user',
        content: `Message ${i}`,
      });
    }

    const messages = contextWithLimit.messages;
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(messages.at(-1)?.content).toBe('Message 9');
    // 旧消息没有静默消失：以摘要形式留在上下文里。
    expect(messages.some((message) => message.content.startsWith('[Auto Compact'))).toBe(true);
  });
});

describe('MemoryContextManager summarizer (0.6.1 E3)', () => {
  function seed(context: MemoryContextManager, count = 10): void {
    for (let i = 0; i < count; i += 1) {
      context.add({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with some content`,
      });
    }
  }

  it('uses the summarizer for compactAsync with the configured budget', async () => {
    const calls: Array<{ count: number; maxTokens: number }> = [];
    const context = new MemoryContextManager({
      maxTokens: 123,
      autoCompact: false,
      summarizer: async (messages, options) => {
        calls.push({ count: messages.length, maxTokens: options.maxTokens });
        return 'SUMMARY: keep paths and decisions';
      },
    });
    seed(context);

    const removed = await context.compactAsync();

    expect(removed).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(123);
    expect(calls[0]?.count).toBe(removed);
    expect(context.messages.some((m) => m.content === 'SUMMARY: keep paths and decisions')).toBe(
      true,
    );
    expect(context.messages.at(-1)?.content).toContain('Message 9');
    expect(context.messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(false);
  });

  it('falls back to the placeholder when the summarizer fails or returns empty', async () => {
    const failing = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => {
        throw new Error('provider down');
      },
    });
    seed(failing);
    expect(await failing.compactAsync()).toBeGreaterThan(0);
    expect(failing.messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(true);

    const empty = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => '   ',
    });
    seed(empty);
    expect(await empty.compactAsync()).toBeGreaterThan(0);
    expect(empty.messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(true);
  });

  it('keeps the placeholder path when no summarizer is configured', async () => {
    const context = new MemoryContextManager({ autoCompact: false });
    seed(context);

    expect(await context.compactAsync()).toBeGreaterThan(0);
    expect(context.messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(true);
  });

  it('defaults the context budget to 1,000,000 tokens', async () => {
    const budgets: number[] = [];
    const context = new MemoryContextManager({
      autoCompact: true,
      summarizer: async (_messages, options) => {
        budgets.push(options.maxTokens);
        return 'DEFAULT BUDGET';
      },
    });
    seed(context);

    await context.compactAsync();
    expect(budgets).toEqual([1_000_000]);

    // 默认阈值 0.8：800k 以下不触发，超过才压缩
    context.updateRealTokens(799_999);
    expect(await context.autoCompactAsync()).toBe(0);
    context.updateRealTokens(800_001);
    expect(await context.autoCompactAsync()).toBeGreaterThan(0);
  });

  it('autoCompactAsync only runs above the threshold', async () => {
    let calls = 0;
    const context = new MemoryContextManager({
      maxTokens: 1_000_000,
      compactThreshold: 0.8,
      summarizer: async () => {
        calls += 1;
        return 'never';
      },
    });
    seed(context);

    expect(await context.autoCompactAsync()).toBe(0);
    expect(calls).toBe(0);
  });

  it('defers auto compaction in add() until autoCompactAsync runs', async () => {
    const context = new MemoryContextManager({
      maxTokens: 20,
      compactThreshold: 0.5,
      autoCompact: true,
      summarizer: async () => 'REAL SUMMARY',
    });
    seed(context, 30);

    // add() 不再同步插入占位符（summarizer 需要 await）
    expect(context.messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(false);
    expect(context.messages).toHaveLength(30);

    const removed = await context.autoCompactAsync();
    expect(removed).toBeGreaterThan(0);
    expect(context.messages.some((m) => m.content === 'REAL SUMMARY')).toBe(true);
  });

  it('applies an in-flight summary to the session it started in', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => {
        await gate;
        return 'SESSION A SUMMARY';
      },
    });
    seed(context);

    const pending = context.compactAsync();
    context.setSessionId('session-b');
    context.add({ role: 'user', content: 'B message' });
    release?.();
    await pending;

    // 切换后的会话不受旧会话压缩影响
    expect(context.messages.map((m) => m.content)).toEqual(['B message']);

    context.setSessionId('default');
    expect(context.messages.some((m) => m.content === 'SESSION A SUMMARY')).toBe(true);
  });

  it('preserves messages added while the summarizer is running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => {
        await gate;
        return 'LATE SUMMARY';
      },
    });
    seed(context);

    const pending = context.compactAsync();
    context.add({ role: 'user', content: 'during-summary' });
    release?.();

    expect(await pending).toBeGreaterThan(0);
    expect(context.messages.some((m) => m.content === 'LATE SUMMARY')).toBe(true);
    expect(context.messages.at(-1)?.content).toBe('during-summary');
  });
});

describe('MemoryContextManager long sessions (0.4 C2)', () => {
  it('does not overwrite a fresh compaction with the pre-compact array', () => {
    const context = new MemoryContextManager({
      maxTokens: 20,
      compactThreshold: 0.5,
      maxMessages: 20,
      autoCompact: true,
    });

    for (let i = 0; i < 30; i += 1) {
      context.add({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with some content`,
      });
    }

    const messages = context.messages;
    expect(messages.some((m) => m.content.includes('[Auto Compact'))).toBe(true);
    expect(messages.at(-1)?.content).toContain('Message 29');
  });

  it('keeps the last added message when maxMessages is smaller than the compact tail', () => {
    const context = new MemoryContextManager({
      maxTokens: 20,
      compactThreshold: 0.5,
      maxMessages: 5,
      autoCompact: true,
    });

    for (let i = 0; i < 50; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }
    context.add({ role: 'user', content: 'last-message' });

    const messages = context.messages;
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(messages.at(-1)?.content).toBe('last-message');
  });

  it('bounds a 10k message session with summaries instead of hard slicing', () => {
    const context = new MemoryContextManager({
      maxMessages: 100,
      autoCompact: false,
    });

    for (let i = 0; i < 10000; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }

    const messages = context.messages;
    expect(messages.length).toBeLessThanOrEqual(100);
    expect(messages.at(-1)?.content).toBe('Message 9999');
    // 安全上限即使 autoCompact=false 也要先摘要，不能静默丢弃旧历史。
    expect(messages.some((m) => m.content.startsWith('[Auto Compact'))).toBe(true);
    expect(new Set(messages.map((m) => m.content)).size).toBe(messages.length);
  });

  it('keeps compaction bounded across repeated threshold crossings', () => {
    const context = new MemoryContextManager({
      maxTokens: 20,
      compactThreshold: 0.5,
      maxMessages: 20,
      autoCompact: true,
    });

    for (let i = 0; i < 500; i += 1) {
      context.add({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with some content`,
      });
    }

    const messages = context.messages;
    expect(messages.length).toBeLessThanOrEqual(20);
    expect(messages.at(-1)?.content).toContain('Message 499');
  });
});

describe('MemoryContextManager token budget (0.10 R1-10)', () => {
  it('summarizes messages past the old 100-message cap instead of dropping them', async () => {
    const summarized: string[] = [];
    const context = new MemoryContextManager({
      maxMessages: 100,
      summarizer: async (messages) => {
        summarized.push(...messages.map((message) => message.content));
        return 'SUMMARY: early context retained';
      },
    });

    for (let i = 0; i < 150; i += 1) {
      context.add({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` });
    }

    // add() 不再硬截断；摘要需要 await，等待运行时在请求前的 autoCompactAsync。
    expect(context.messages).toHaveLength(150);
    expect(summarized).toHaveLength(0);

    expect(await context.autoCompactAsync()).toBeGreaterThan(0);
    expect(summarized).toContain('Message 0');
    expect(summarized).toContain('Message 99');
    expect(context.messages.some((m) => m.content === 'SUMMARY: early context retained')).toBe(
      true,
    );
    expect(context.messages.at(-1)?.content).toBe('Message 149');
    expect(context.messages.length).toBeLessThan(150);
  });

  it('forces overflow compaction even when autoCompact is disabled', async () => {
    let calls = 0;
    const context = new MemoryContextManager({
      maxMessages: 5,
      autoCompact: false,
      summarizer: async () => {
        calls += 1;
        return 'OVERFLOW SUMMARY';
      },
    });

    for (let i = 0; i < 8; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }

    expect(context.messages).toHaveLength(8);
    expect(await context.autoCompactAsync()).toBeGreaterThan(0);
    expect(calls).toBe(1);
    expect(context.messages.some((m) => m.content === 'OVERFLOW SUMMARY')).toBe(true);
    expect(context.messages.at(-1)?.content).toBe('Message 7');
  });

  it('counts tool_calls arguments, reasoning_content, and message name', () => {
    const message = {
      role: 'assistant' as const,
      content: 'x'.repeat(400),
      name: 'agent',
      reasoning_content: 'r'.repeat(400),
      tool_calls: [
        {
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'bash', arguments: 'a'.repeat(800) },
        },
      ],
    };

    // content 100 + name 2 + reasoning 100 + function name 1 + arguments 200
    expect(estimateMessageTokens(message)).toBe(403);

    const context = new MemoryContextManager({ autoCompact: false });
    context.add(message);
    expect(context.tokenCount).toBe(estimateMessageTokens(message));
    expect(context.tokenCount).toBe(estimateMessagesTokens(context.messages));
  });

  it('keeps system messages and reports overflow compactions', () => {
    const compactions: Array<{ removed: number; remaining: number }> = [];
    const context = new MemoryContextManager({
      maxMessages: 5,
      autoCompact: false,
      onCompact: (removed, remaining) => compactions.push({ removed, remaining }),
    });
    context.add({ role: 'system', content: 'SYSTEM PROMPT' });
    for (let i = 0; i < 40; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }

    const messages = context.messages;
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    // 摘要也是 system，但不是基底 system：基底只能有一条，摘要另算。
    expect(messages.filter((m) => m.role === 'system' && !m.compaction_summary)).toHaveLength(1);
    expect(messages.filter((m) => m.compaction_summary)).toHaveLength(1);
    expect(messages.at(-1)?.content).toBe('Message 39');
    // 无 summarizer 时也不静默：占位摘要 + onCompact 通知都可见。
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.at(-1)?.removed).toBeGreaterThan(0);
  });

  it('triggers exactly when the shared estimate crosses maxTokens * threshold', async () => {
    let calls = 0;
    const context = new MemoryContextManager({
      maxTokens: 1000,
      compactThreshold: 0.8,
      summarizer: async () => {
        calls += 1;
        return 'THRESHOLD SUMMARY';
      },
    });

    for (let i = 0; i < 7; i += 1) {
      context.add({ role: 'user', content: `${i}`.padEnd(397, 'a') });
    }

    expect(context.tokenCount).toBe(estimateMessagesTokens(context.messages));
    expect(context.tokenCount).toBe(700);
    expect(await context.autoCompactAsync()).toBe(0);
    expect(calls).toBe(0);

    context.add({ role: 'user', content: 'b'.repeat(400) });
    expect(context.tokenCount).toBe(800);
    expect(await context.autoCompactAsync()).toBe(0);

    context.add({ role: 'user', content: 'c'.repeat(400) });
    expect(context.tokenCount).toBe(900);
    expect(await context.autoCompactAsync()).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });
});

describe('MemoryContextManager compaction summary shape (0.14.2 F1)', () => {
  function seedUsers(context: MemoryContextManager, from: number, to: number): void {
    for (let i = from; i < to; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }
  }

  it('keeps the summary out of the assistant role so thinking providers accept the request', async () => {
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => 'SUMMARY',
    });
    context.add({ role: 'system', content: 'SYSTEM PROMPT' });
    seedUsers(context, 0, 10);

    await context.compactAsync();

    const messages = context.messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    // 摘要必须紧跟 system、位于其它消息之前，且不是 assistant（无 reasoning_content）。
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.compaction_summary).toBe(true);
    expect(messages[1]?.content).toBe('SUMMARY');
    expect(messages.slice(2).every((m) => m.role !== 'system')).toBe(true);
  });

  it('drops the previous summary so only one compaction summary survives repeated compactions', async () => {
    let round = 0;
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => {
        round += 1;
        return `SUMMARY ${round}`;
      },
    });
    context.add({ role: 'system', content: 'SYSTEM PROMPT' });
    seedUsers(context, 0, 10);
    await context.compactAsync();

    seedUsers(context, 10, 13);
    await context.compactAsync();

    const summaries = context.messages.filter((m) => m.compaction_summary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toBe('SUMMARY 2');
  });

  it('keeps reasoning_content on an assistant(tool_calls) retained by compaction', async () => {
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => 'SUMMARY',
    });
    seedUsers(context, 0, 6);
    context.add({
      role: 'assistant',
      content: '',
      reasoning_content: 'THINK',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    });
    context.add({ role: 'tool', tool_call_id: 'call-1', content: 'RESULT' });

    await context.compactAsync();

    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('THINK');
    expect(assistant?.tool_calls?.[0]?.id).toBe('call-1');
  });

  it('keeps retained tool results paired with their assistant tool_calls after compaction', async () => {
    const context = new MemoryContextManager({
      autoCompact: false,
      summarizer: async () => 'SUMMARY',
    });
    seedUsers(context, 0, 6);
    context.add({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    });
    context.add({ role: 'tool', tool_call_id: 'call-1', content: 'RESULT' });

    await context.compactAsync();

    const messages = context.messages;
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(messages[assistantIndex + 1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'RESULT',
    });
    const calledIds = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((call) => call.id)));
    for (const message of messages.filter((m) => m.role === 'tool')) {
      expect(calledIds.has(message.tool_call_id ?? '')).toBe(true);
    }
  });
});
