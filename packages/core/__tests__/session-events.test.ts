import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemorySessionBackend } from '../src/session/session-backend';

describe('session / plugin lifecycle events (0.5)', () => {
  it('emits session.saved and plugin.loaded with tenant_id', async () => {
    const events = new MemoryEventStream();
    const runtime = await AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'm',
      context: new MemoryContextManager(),
      events,
      limits: {},
      termination: { maxIterations: 3 },
      session: new MemorySessionBackend(),
      tenantId: 'acme',
      plugins: [{ name: 'demo', version: '1.0.0', install: () => {} }],
    });

    await runtime.run('hello', 's1', { runId: 'r1' });

    const history = events.getHistory();
    const loaded = history.find((e) => e.type === 'plugin.loaded');
    expect(loaded?.data).toMatchObject({ name: 'demo', version: '1.0.0' });
    expect(loaded?.tenant_id).toBe('acme');

    const saved = history.filter((e) => e.type === 'session.saved');
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((e) => e.tenant_id === 'acme')).toBe(true);
    expect(saved.every((e) => (e.data as { session_id: string }).session_id === 's1')).toBe(true);
  });

  it('emits plugin.failed when install throws', async () => {
    const events = new MemoryEventStream();
    await expect(
      AgentRuntime.create({
        provider: new MemoryLLMProvider(),
        model: 'm',
        context: new MemoryContextManager(),
        events,
        limits: {},
        termination: { maxIterations: 3 },
        tenantId: 'acme',
        plugins: [
          {
            name: 'broken',
            install: () => {
              throw new Error('install failed');
            },
          },
        ],
      }),
    ).rejects.toThrow('install failed');

    const failed = events.getHistory().find((e) => e.type === 'plugin.failed');
    expect(failed?.data).toMatchObject({ name: 'broken', error: 'install failed' });
    expect(failed?.tenant_id).toBe('acme');
  });
});
