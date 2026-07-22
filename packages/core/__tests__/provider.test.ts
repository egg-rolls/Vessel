import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryLLMProvider } from '../src/provider/providers';
import type { ChatRequest } from '../src/types/provider';

describe('MemoryLLMProvider', () => {
  let provider: MemoryLLMProvider;

  beforeEach(() => {
    provider = new MemoryLLMProvider();
  });

  it('should return echo response by default', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'test-model',
    };

    const response = await provider.chat(request);

    expect(response.content).toBe('Echo: Hello');
    expect(response.finish_reason).toBe('stop');
    expect(response.usage).toBeDefined();
    expect(response.usage?.prompt_tokens).toBe(5);
  });

  it('should return preset responses', async () => {
    provider.setResponse('weather', {
      content: 'The weather is sunny!',
      finish_reason: 'stop',
    });

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'What is the weather?' }],
      model: 'test-model',
    };

    const response = await provider.chat(request);

    expect(response.content).toBe('The weather is sunny!');
  });

  it('should track call count', async () => {
    expect(provider.getCallCount()).toBe(0);

    await provider.chat({
      messages: [{ role: 'user', content: 'Test 1' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(1);

    await provider.chat({
      messages: [{ role: 'user', content: 'Test 2' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(2);
  });

  it('should reset call count', async () => {
    await provider.chat({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    });

    expect(provider.getCallCount()).toBe(1);

    provider.resetCallCount();

    expect(provider.getCallCount()).toBe(0);
  });
});
