import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { FileSessionBackend } from '../src/session/file-backend';
import { toSessionInfo } from '../src/session/session-backend';
import type { RunState } from '../src/types/session';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-session-fields-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    session_id: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    started_at: 1000,
    updated_at: 2000,
    status: 'completed',
    ...overrides,
  };
}

describe('session end fields (0.6.1 P2)', () => {
  it('toSessionInfo carries ended_at/end_reason only when present', () => {
    const ended = toSessionInfo(runState({ ended_at: 3000, end_reason: 'resume' }));
    expect(ended.ended_at).toBe(3000);
    expect(ended.end_reason).toBe('resume');

    const active = toSessionInfo(runState());
    expect('ended_at' in active).toBe(false);
    expect('end_reason' in active).toBe(false);
  });

  it('FileSessionBackend round-trips ended_at/end_reason', async () => {
    const dir = tempDir();
    const backend = new FileSessionBackend(dir);
    await backend.save(runState({ ended_at: 3000, end_reason: 'exit' }));

    const loaded = await backend.load('s1');
    expect(loaded?.ended_at).toBe(3000);
    expect(loaded?.end_reason).toBe('exit');

    const info = (await backend.listRich())[0];
    expect(info?.ended_at).toBe(3000);
    expect(info?.end_reason).toBe('exit');
  });
});

describe('message timestamps (0.6.1 P2)', () => {
  async function runtimeWith(context: MemoryContextManager) {
    return AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      context,
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
    });
  }

  it('stamps user and assistant messages when they enter the context', async () => {
    const context = new MemoryContextManager();
    const runtime = await runtimeWith(context);

    await runtime.run('hello');

    const user = context.messages.find((m) => m.role === 'user');
    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(typeof user?.timestamp).toBe('number');
    expect(typeof assistant?.timestamp).toBe('number');
  });

  it('preserves an existing timestamp on injected messages', async () => {
    const context = new MemoryContextManager();
    const runtime = await runtimeWith(context);

    await runtime.run('hello', 's1', {
      messages: [{ role: 'user', content: 'injected', timestamp: 111 }],
    });

    expect(context.messages.find((m) => m.content === 'injected')?.timestamp).toBe(111);
  });
});
