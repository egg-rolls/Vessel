import { describe, it, expect, beforeEach } from 'bun:test';
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
    expect(context.messages[0].content).toBe('Hello');
    expect(context.messages[1].content).toBe('Hi there!');
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
      maxTokens: 20,  // 更小的 maxTokens
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
    expect(contextWithLimit.messages[0].content).toBe('Message 5');
    expect(contextWithLimit.messages[4].content).toBe('Message 9');
  });
});
