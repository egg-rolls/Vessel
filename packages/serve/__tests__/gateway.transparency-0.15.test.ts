import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { normalizeDurableRun } from '../src/gateway/methods/runs';
import { createLocalRpcDispatcher, type LocalRpcDispatcher } from '../src/local';
import type { TeamHostLike } from '../src/team';
import type { ConfigSnapshotLike, GatewayAuthLike } from '../src/tenant';
import { createGatewayEventHub } from '../src/tenant-event-hub';
import { createRuntime, SlowProvider, startTestGateway as startGateway } from './helpers';
import { runDispatcher } from './rpc-test-utils';

const dispatchers: LocalRpcDispatcher[] = [];
const gateways: Gateway[] = [];

function hubFor(events: MemoryEventStream) {
  return createGatewayEventHub({ streams: [{ tenantId: 'default', stream: events }] });
}

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.dispose();
  for (const gateway of gateways.splice(0)) void gateway.stop();
});

function event(type: string, runId: string, data: Record<string, unknown>, ts = 1000): RunEvent {
  return { type, run_id: runId, data, ts };
}

function authFor(): GatewayAuthLike {
  return {
    configured: true,
    authenticate: (token) => {
      if (token === 'd') return { tenant_id: 'default', role: 'write' };
      if (token === 'b') return { tenant_id: 'b', role: 'write' };
      return null;
    },
  };
}

async function postRpc(
  url: string,
  token: string,
  method: string,
  params?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
  const response = await fetch(`${url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, ...(params ? { params } : {}) }),
  });
  return (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string } };
}

function snapshot(): ConfigSnapshotLike {
  return {
    schema_version: 1,
    config: { ui: { verbosity: 'normal' } },
    sources: {},
  };
}

describe('agents.tree / tasks.* (0.15 E5)', () => {
  it('exposes children ids and queue fields without inventing nodes', async () => {
    const events = new MemoryEventStream();
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events) });
    dispatchers.push(dispatcher);

    events.publish(
      event('subagent.delegate.started', 'root', {
        delegateId: 'd1',
        depth: 0,
        task: 'research',
      }),
    );
    events.publish(event('subagent.run.started', 'r1', { agentId: 'd1', session_id: 's1' }, 2));
    events.publish(
      event('subagent.delegate.started', 'r1', { delegateId: 'd2', depth: 1, task: 'nested' }, 3),
    );
    events.publish(
      event(
        'subagent.delegate.completed',
        'r1',
        { delegateId: 'd2', result_ref: 'file:///tmp/out.md' },
        4,
      ),
    );
    events.publish(
      event(
        'agent.queue.entered',
        'r1',
        {
          agent_id: 'd1',
          position: 1,
          wait_reason: 'model_slot',
        },
        5,
      ),
    );

    const tree = (await runDispatcher(dispatcher.dispatch, 'agents.tree')) as {
      nodes: Array<Record<string, unknown>>;
      as_of: number;
    };
    expect(typeof tree.as_of).toBe('number');
    expect(tree.nodes).toHaveLength(2);
    const d1 = tree.nodes.find((node) => node.id === 'd1');
    expect(d1).toMatchObject({
      children_ids: ['d2'],
      children_count: 1,
      task: 'research',
      session_id: 's1',
      queue_position: 1,
      wait_reason: 'model_slot',
      state: 'queued',
    });
    expect(typeof d1?.last_seen).toBe('number');
    const d2 = tree.nodes.find((node) => node.id === 'd2');
    expect(d2).toMatchObject({
      parent_id: 'd1',
      children_ids: [],
      children_count: 0,
      state: 'completed',
    });

    const tasks = (await runDispatcher(dispatcher.dispatch, 'tasks.list')) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(tasks.tasks).toHaveLength(2);
    expect(tasks.tasks.find((task) => task.id === 'd2')).toMatchObject({
      title: 'nested',
      assignee: 'd2',
      status: 'completed',
      parent_task: 'd1',
      artifact_refs: ['file:///tmp/out.md'],
    });
    const single = (await runDispatcher(dispatcher.dispatch, 'tasks.get', { task_id: 'd1' })) as {
      task: Record<string, unknown>;
    };
    expect(single.task.title).toBe('research');

    await expect(
      runDispatcher(dispatcher.dispatch, 'tasks.get', { task_id: 'missing' }),
    ).rejects.toThrow('not_found');
  });

  it('merges E3 host snapshot fields', async () => {
    const events = new MemoryEventStream();
    const host: TeamHostLike = {
      list: () => [{ id: 'worker', state: 'running', toolNames: [] }],
      get: () => undefined,
      inbox: async (_id, cursor = '0') => ({ messages: [], cursor }),
      cancel: () => undefined,
      snapshot: () => ({
        agents: [
          {
            id: 'worker',
            state: 'running',
            sessionId: 's1',
            queuePosition: 2,
            waitReason: 'capacity',
            contextUsed: 10,
            contextMax: 100,
            task: { id: 't1', title: 'index' },
            nodeId: 'A',
            lastSeen: 123,
          },
        ],
      }),
    };
    const dispatcher = createLocalRpcDispatcher({
      hub: hubFor(events),
      team: { nodeId: 'A', host },
    });
    dispatchers.push(dispatcher);

    const tree = (await runDispatcher(dispatcher.dispatch, 'agents.tree')) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(tree.nodes[0]).toMatchObject({
      id: 'worker',
      role: 'agent',
      state: 'running',
      session_id: 's1',
      queue_position: 2,
      wait_reason: 'capacity',
      context_used: 10,
      context_max: 100,
      task: 'index',
      node_id: 'A',
      last_seen: 123,
    });
  });

  it('hides other tenants tasks', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({ events, port: 0, auth: authFor(), config: { snapshot } });
    gateways.push(gateway);

    events.publish({
      ...event('subagent.delegate.started', 'root', { delegateId: 'b-task', task: 'b' }),
      tenant_id: 'b',
    });

    const asDefault = await postRpc(gateway.url, 'd', 'tasks.list');
    expect((asDefault.result as { tasks: unknown[] }).tasks).toEqual([]);
    const asB = await postRpc(gateway.url, 'b', 'tasks.list');
    expect((asB.result as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id)).toEqual([
      'b-task',
    ]);
  });
});

describe('health.get runtime (0.15 E6)', () => {
  it('reports queued/running runs from the engine', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(300) });
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events), runtime });
    dispatchers.push(dispatcher);

    const empty = (await runDispatcher(dispatcher.dispatch, 'health.get')) as {
      runtime: { scheduler: { queued: unknown[]; running: unknown[]; stats: { queued: number } } };
    };
    expect(empty.runtime.scheduler.queued).toEqual([]);
    expect(empty.runtime.scheduler.running).toEqual([]);
    expect(empty.runtime.scheduler.stats.queued).toBe(0);

    const first = (await runDispatcher(dispatcher.dispatch, 'runs.start', { input: 'one' })) as {
      run_id: string;
    };
    const second = (await runDispatcher(dispatcher.dispatch, 'runs.start', { input: 'two' })) as {
      run_id: string;
    };

    const health = (await runDispatcher(dispatcher.dispatch, 'health.get')) as {
      runtime: {
        active_run_id?: string;
        scheduler: {
          queued: Array<{ run_id: string; queue_position?: number; status: string }>;
          running: Array<{ run_id: string; status: string }>;
          stats: { queued: number; running: number };
        };
      };
    };
    const queuedIds = health.runtime.scheduler.queued.map((run) => run.run_id);
    const runningIds = health.runtime.scheduler.running.map((run) => run.run_id);
    expect([...queuedIds, ...runningIds].sort()).toEqual([first.run_id, second.run_id].sort());
    expect(health.runtime.scheduler.queued).toHaveLength(1);
    expect(health.runtime.scheduler.queued[0]?.queue_position).toBe(1);
    expect(health.runtime.scheduler.stats.queued).toBe(1);
    expect(health.runtime.scheduler.stats.running).toBe(1);
    expect(health.runtime.active_run_id).toBe(
      runningIds.includes(first.run_id) ? first.run_id : second.run_id,
    );

    await runDispatcher(dispatcher.dispatch, 'runs.cancel', { run_id: first.run_id });
    await runDispatcher(dispatcher.dispatch, 'runs.cancel', { run_id: second.run_id });
  });
});

describe('runs error envelope (0.15 E6)', () => {
  it('stores run.failed envelope on the live record', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(300) });
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events), runtime });
    dispatchers.push(dispatcher);

    const started = (await runDispatcher(dispatcher.dispatch, 'runs.start', { input: 'boom' })) as {
      run_id: string;
    };
    const before = (await runDispatcher(dispatcher.dispatch, 'runs.get', {
      run_id: started.run_id,
    })) as { run: { core_run_id?: string } };
    const coreRunId = before.run.core_run_id;
    if (!coreRunId) throw new Error('core run id not assigned');
    events.publish(
      event(
        'run.failed',
        coreRunId,
        {
          error: 'provider down',
          error_code: 'provider_unavailable',
          category: 'provider',
          phase: 'llm',
          retryable: true,
          http_status: 503,
          details: { provider: 'openai' },
        },
        3,
      ),
    );

    const run = (await runDispatcher(dispatcher.dispatch, 'runs.get', {
      run_id: started.run_id,
    })) as { run: Record<string, unknown> };
    expect(run.run).toMatchObject({
      error_code: 'provider_unavailable',
      category: 'provider',
      phase: 'llm',
      retryable: true,
      http_status: 503,
      details: { provider: 'openai' },
    });

    await runDispatcher(dispatcher.dispatch, 'runs.cancel', { run_id: started.run_id });
  });

  it('lifts envelope and started_at from durable metadata', () => {
    const normalized = normalizeDurableRun({
      run_id: 'r1',
      session_id: 's1',
      status: 'failed',
      created_at: 111,
      messages: [],
      metadata: {
        error_envelope: {
          error_code: 'tool_timeout',
          category: 'tool',
          phase: 'tool',
          retryable: true,
        },
      },
    });
    expect(normalized.started_at).toBe(111);
    expect(normalized).toMatchObject({
      error_code: 'tool_timeout',
      category: 'tool',
      phase: 'tool',
      retryable: true,
    });
  });
});

describe('events.list read path (0.15 E6)', () => {
  it('redacts and caps tool payloads like the live stream', async () => {
    const events = new MemoryEventStream();
    const huge = 'x'.repeat(20 * 1024);
    const dispatcher = createLocalRpcDispatcher({
      hub: hubFor(events),
      trace: {
        readEvents: async () => [
          {
            type: 'tool.call.completed',
            run_id: 'r1',
            data: { result: huge, api_key: 'secret-value' },
            ts: 1,
          },
        ],
      },
    });
    dispatchers.push(dispatcher);

    const result = (await runDispatcher(dispatcher.dispatch, 'events.list')) as {
      events: Array<{ data: Record<string, unknown> }>;
    };
    const data = result.events[0]?.data ?? {};
    expect(data.api_key).toBe('***');
    expect(data.truncated).toBe(true);
    const capped = data.result as string;
    expect(typeof capped).toBe('string');
    expect(capped.length).toBeLessThan(huge.length);
    expect(capped.endsWith('... [truncated]')).toBe(true);
  });
});

describe('config.set (0.15)', () => {
  it('writes whitelisted keys and rejects everything else', async () => {
    const events = new MemoryEventStream();
    const writes: Array<{ key: string; value: string | boolean; tenantId: string }> = [];
    const dispatcher = createLocalRpcDispatcher({
      hub: hubFor(events),
      config: {
        snapshot,
        set: (request) => {
          writes.push(request);
        },
      },
    });
    dispatchers.push(dispatcher);

    const saved = (await runDispatcher(dispatcher.dispatch, 'config.set', {
      key: 'ui.verbosity',
      value: 'debug',
    })) as { ok: boolean; key: string; value: unknown };
    expect(saved).toEqual({ ok: true, key: 'ui.verbosity', value: 'debug' });
    expect(writes).toEqual([{ key: 'ui.verbosity', value: 'debug', tenantId: 'default' }]);

    const bool = (await runDispatcher(dispatcher.dispatch, 'config.set', {
      key: 'ui.askUser',
      value: 'false',
    })) as { value: unknown };
    expect(bool.value).toBe(false);

    await expect(
      runDispatcher(dispatcher.dispatch, 'config.set', { key: 'provider.apiKey', value: 'x' }),
    ).rejects.toThrow('invalid_params');
    await expect(
      runDispatcher(dispatcher.dispatch, 'config.set', { key: 'ui.verbosity', value: 'loud' }),
    ).rejects.toThrow('invalid_params');
  });

  it('returns not_found without a writer', async () => {
    const dispatcher = createLocalRpcDispatcher({
      hub: createGatewayEventHub(),
      config: { snapshot },
    });
    dispatchers.push(dispatcher);
    await expect(
      runDispatcher(dispatcher.dispatch, 'config.set', { key: 'ui.verbosity', value: 'debug' }),
    ).rejects.toThrow('not_found');
  });

  it('rejects non-default tenants', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      auth: authFor(),
      config: { snapshot, set: () => undefined },
    });
    gateways.push(gateway);
    const denied = await postRpc(gateway.url, 'b', 'config.set', {
      key: 'ui.verbosity',
      value: 'debug',
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('forbidden');
  });
});
