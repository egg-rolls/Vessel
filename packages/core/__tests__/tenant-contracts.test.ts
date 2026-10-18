import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { createRuntime } from '../src/kernel/create-runtime';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { GuardrailRunner } from '../src/runtime/guardrail-runner';
import { PermissionPolicy } from '../src/runtime/permission-policy';
import { FileSessionBackend } from '../src/session/file-backend';
import { FileRunStore } from '../src/session/run-store';
import { MemorySessionBackend, toSessionInfo } from '../src/session/session-backend';
import { SQLiteSessionBackend } from '../src/session/sqlite-backend';
import { GuardrailStage } from '../src/types/guardrail';
import type { PluginHost } from '../src/types/plugin';
import type { RunCheckpoint } from '../src/types/run-store';
import type { RunState } from '../src/types/session';
import type { ToolDefinition } from '../src/types/tool';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-tenant-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

function runState(sessionId: string): RunState {
  return {
    run_id: 'run-1',
    session_id: sessionId,
    messages: [{ role: 'user', content: 'hi' }],
    started_at: Date.now(),
    status: 'completed',
  };
}

function checkpoint(runId: string, tenantId?: string): RunCheckpoint {
  return {
    run_id: runId,
    session_id: 's1',
    status: 'completed',
    messages: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('runtime tenant stamping (0.5 E6)', () => {
  it('stamps tenant_id on events, RunState, and checkpoints', async () => {
    const events = new MemoryEventStream();
    const session = new MemorySessionBackend();
    const runStore = new FileRunStore({ dir: tempDir(), tenantId: 'acme' });
    const runtime = await AgentRuntime.create({
      provider: new MemoryLLMProvider(),
      model: 'test-model',
      context: new MemoryContextManager(),
      events,
      limits: {},
      termination: { maxIterations: 3 },
      session,
      runStore,
      tenantId: 'acme',
    });

    await runtime.run('hello', 's1', { runId: 'run-1' });

    expect(events.getHistory().every((event) => event.tenant_id === 'acme')).toBe(true);
    expect((await session.load('s1'))?.tenant_id).toBe('acme');
    expect((await runStore.load('run-1'))?.tenant_id).toBe('acme');
  });

  it('propagates the host tenant to member events', async () => {
    const host = await createRuntime({ tenantId: 'acme' });
    const agent = await host.spawn({ id: 'worker', provider: new MemoryLLMProvider(), model: 'm' });

    await (await agent.run('hello')).result;

    const events = host.events.getHistory();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.tenant_id === 'acme')).toBe(true);
    await host.close();
  });

  it('stamps permission requests', async () => {
    const events = new MemoryEventStream();
    const policy = new PermissionPolicy(events, { default: 'ask' }, 'acme');
    const tool: ToolDefinition = {
      name: 'bash',
      description: '',
      inputSchema: {},
      handler: async () => '',
    };

    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      const requestId = (event.data as { requestId: string }).requestId;
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId, decision: 'allow' },
        ts: Date.now(),
      });
    });

    await policy.authorize(
      tool,
      {},
      {
        run_id: 'run-1',
        session_id: 's1',
        messages: [],
        events,
      },
    );

    const request = events.getHistory().find((e) => e.type === 'tool.permission.request');
    expect(request?.tenant_id).toBe('acme');
  });

  it('stamps guardrail blocked events', async () => {
    const events = new MemoryEventStream();
    const guardrail = {
      name: 'blocker',
      stage: GuardrailStage.Input,
      check: async () => ({ allowed: false, reason: 'nope' }),
    };
    const host = {
      getGuardrails: () => [guardrail],
    } as unknown as PluginHost;
    const runner = new GuardrailRunner(host, events, 'acme');

    const outcome = await runner.apply('x', GuardrailStage.Input, 'run-1', 's1');

    expect(outcome.allowed).toBe(false);
    expect(events.getHistory()[0]?.tenant_id).toBe('acme');
  });
});

describe('tenant isolation in file/sqlite backends (0.5 E4)', () => {
  it('FileSessionBackend stamps, filters, and rejects foreign sessions', async () => {
    const dir = tempDir();
    const acme = new FileSessionBackend(dir, { tenantId: 'acme' });
    const other = new FileSessionBackend(dir, { tenantId: 'other' });

    await acme.save(runState('s1'));
    expect((await acme.load('s1'))?.tenant_id).toBe('acme');
    expect(await other.load('s1')).toBeNull();
    await expect(other.save({ ...runState('s1'), tenant_id: 'acme' })).rejects.toThrow(
      /tenant_mismatch/,
    );
  });

  it('FileRunStore stamps, filters, and rejects foreign checkpoints', async () => {
    const dir = tempDir();
    const acme = new FileRunStore({ dir, tenantId: 'acme' });
    const other = new FileRunStore({ dir, tenantId: 'other' });

    await acme.save(checkpoint('run-1'));
    expect((await acme.load('run-1'))?.tenant_id).toBe('acme');
    expect(await other.load('run-1')).toBeNull();
    await expect(other.save(checkpoint('run-1', 'acme'))).rejects.toThrow(/tenant_mismatch/);
  });

  it('SQLiteSessionBackend round-trips tenant_id', async () => {
    const backend = new SQLiteSessionBackend(':memory:');
    const state = { ...runState('s1'), tenant_id: 'acme' };

    await backend.save(state);
    expect((await backend.load('s1'))?.tenant_id).toBe('acme');
    expect((await backend.listRich())[0]?.tenant_id).toBe('acme');
  });

  it('toSessionInfo carries tenant_id', () => {
    expect(toSessionInfo({ ...runState('s1'), tenant_id: 'acme' }).tenant_id).toBe('acme');
  });
});
