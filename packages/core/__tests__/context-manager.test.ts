import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';

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

  it('should limit max messages', () => {
    const config = {
      maxMessages: 5,
    };

    const contextWithLimit = new MemoryContextManager(config);

    for (let i = 0; i < 10; i++) {
      contextWithLimit.add({
        role: 'user',
        content: `Message ${i}`,
      });
    }

    expect(contextWithLimit.messages).toHaveLength(5);
    // 应该保留最后5条
    expect(contextWithLimit.messages[0]?.content).toBe('Message 5');
    expect(contextWithLimit.messages[4]?.content).toBe('Message 9');
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

  it('bounds a 10k message session without duplicating messages', () => {
    const context = new MemoryContextManager({
      maxMessages: 100,
      autoCompact: false,
    });

    for (let i = 0; i < 10000; i += 1) {
      context.add({ role: 'user', content: `Message ${i}` });
    }

    const messages = context.messages;
    expect(messages).toHaveLength(100);
    expect(messages[0]?.content).toBe('Message 9900');
    expect(messages.at(-1)?.content).toBe('Message 9999');
    expect(new Set(messages.map((m) => m.content)).size).toBe(100);
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
