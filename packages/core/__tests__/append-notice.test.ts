import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { MemorySessionBackend } from '../src/session/session-backend';
import type { ChatRequest, LLMProvider, LLMResponse } from '../src/types/provider';

function capturingProvider(): { provider: LLMProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    provider: {
      async chat(req): Promise<LLMResponse> {
        requests.push(req);
        return { content: 'ok', finish_reason: 'stop' };
      },
    },
  };
}

describe('AgentRuntime.appendNotice', () => {
  it('appends a tail notice without starting a run and exposes it in the next request', async () => {
    const { provider, requests } = capturingProvider();
    const events = new MemoryEventStream();
    const context = new MemoryContextManager();
    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context,
      events,
      session: new MemorySessionBackend(),
      limits: {},
      termination: { maxIterations: 10 },
    });
    const published: string[] = [];
    const notices: unknown[] = [];
    events.subscribe((event) => {
      published.push(event.type);
      if (event.type === 'context.changed') notices.push(event.data);
    });

    await runtime.run('hello', 'notice-session');
    expect(requests).toHaveLength(1);

    runtime.appendNotice('[runtime] identity changed: member -> temporary; owner=main; team=none');

    // notice 不入队、不启动 run。
    expect(requests).toHaveLength(1);
    expect(published).toContain('context.changed');
    const lastContext = context.messages.at(-1);
    expect(lastContext?.role).toBe('user');
    expect(lastContext?.name).toBe('vessel:notice');
    expect(lastContext?.content).toContain('identity changed');
    expect(notices.length).toBeGreaterThan(0);

    await runtime.run('again', 'notice-session');
    const second = requests[1]?.messages ?? [];
    // 下一轮请求尾部：notice 紧邻新用户输入之前。
    expect(second.at(-2)?.name).toBe('vessel:notice');
    expect(second.at(-2)?.content).toContain('identity changed');
    expect(second.at(-1)).toMatchObject({ role: 'user', content: 'again' });
  });
});
