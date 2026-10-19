import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { FileRunStore } from '../src/session/run-store';
import type { ChatRequest, LLMProvider, LLMResponse } from '../src/types/provider';
import type { RunCheckpoint } from '../src/types/run-store';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-recovery-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

class StaticProvider implements LLMProvider {
  readonly seen: string[][] = [];

  constructor(private readonly output: string) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.seen.push(req.messages.map((message) => message.content));
    return { content: this.output, finish_reason: 'stop' };
  }
}

class ControlledProvider implements LLMProvider {
  private readonly resolvers: Array<(response: LLMResponse) => void> = [];
  private readonly starters: Array<() => void> = [];

  waitForRequest(): Promise<void> {
    return new Promise((resolve) => {
      this.starters.push(resolve);
    });
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.starters.shift()?.();

    return await new Promise<LLMResponse>((resolve, reject) => {
      const signal = req.signal;
      const resolver = (response: LLMResponse) => {
        cleanup();
        resolve(response);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(String(signal?.reason ?? 'aborted')));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        const index = this.resolvers.indexOf(resolver);
        if (index >= 0) this.resolvers.splice(index, 1);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resolvers.push(resolver);
    });
  }

  respond(content = 'done'): void {
    this.resolvers.shift()?.({ content, finish_reason: 'stop' });
  }
}

async function createRuntime(provider: LLMProvider, runStore: FileRunStore): Promise<AgentRuntime> {
  return await AgentRuntime.create({
    provider,
    model: 'test-model',
    context: new MemoryContextManager(),
    events: new MemoryEventStream(),
    limits: { requestLimit: 20, toolCallsLimit: 10 },
    termination: { maxIterations: 10, maxRuntimeSeconds: 60 },
    pluginHost: new MemoryPluginHost(),
    runStore,
  });
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-crash',
    session_id: 'session-crash',
    status: 'running',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question before crash' },
      { role: 'assistant', content: 'partial answer' },
      { role: 'user', content: 'continue' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, total_cost: 0.01 },
    iteration: 2,
    created_at: 1_000,
    updated_at: 2_000,
    ...overrides,
  };
}

describe('durable crash recovery（C1）', () => {
  it('磁盘上的 running checkpoint 可由新实例恢复并完成', async () => {
    const dir = await tempDir();
    await new FileRunStore({ dir }).save(checkpoint());

    const provider = new StaticProvider('after-recovery');
    const runtime = await createRuntime(provider, new FileRunStore({ dir }));

    await expect(runtime.resume('run-crash')).resolves.toBe('after-recovery');
    expect(provider.seen[0]).toEqual([
      'sys',
      'question before crash',
      'partial answer',
      'continue',
    ]);

    const final = await new FileRunStore({ dir }).load('run-crash');
    expect(final?.status).toBe('completed');
    expect(final?.iteration).toBe(3);
    expect(final?.run_id).toBe('run-crash');
  });

  it('恢复中再次中断 → cancelled；再次 resume → run_not_resumable', async () => {
    const dir = await tempDir();
    await new FileRunStore({ dir }).save(checkpoint());

    const provider = new ControlledProvider();
    const runtime = await createRuntime(provider, new FileRunStore({ dir }));

    const controller = new AbortController();
    const started = provider.waitForRequest();
    const first = runtime.resume('run-crash', { signal: controller.signal });
    await started;
    controller.abort('user-cancel');
    await expect(first).rejects.toThrow('user-cancel');

    expect((await new FileRunStore({ dir }).load('run-crash'))?.status).toBe('cancelled');
    await expect(runtime.resume('run-crash')).rejects.toMatchObject({
      code: 'run_not_resumable',
    });
  });
});
