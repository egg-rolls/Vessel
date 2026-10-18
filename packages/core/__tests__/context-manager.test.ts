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
