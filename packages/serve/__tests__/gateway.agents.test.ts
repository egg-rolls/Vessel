import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createLocalRpcDispatcher, type LocalRpcDispatcher } from '../src/local';
import { createGatewayEventHub } from '../src/tenant-event-hub';
import { createRuntime, SlowProvider } from './helpers';
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

function event(
  type: string,
  runId: string,
  data: Record<string, unknown>,
  ts = 1000,
  tenantId?: string,
): RunEvent {
  return {
    type,
    run_id: runId,
    data,
    ts,
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  };
}

describe('agents RPC', () => {
  it('derives agents from subagent events and returns not_found for unknown ids', async () => {
    const events = new MemoryEventStream();
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events) });
    dispatchers.push(dispatcher);

    const started = event('subagent.delegate.started', 'root', {
      delegateId: 'd1',
      depth: 0,
      task: 'research',
    });
    events.publish(started);
    events.publish(
      event('subagent.run.started', 'r1', { agentId: 'd1', run_id: 'r1', session_id: 's1' }),
    );

    const listed = (await runDispatcher(dispatcher.dispatch, 'agents.list')) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({
      id: 'd1',
      role: 'subagent',
      depth: 0,
      state: 'running',
      session_id: 's1',
    });
    // 内部字段不泄漏
    expect(listed.agents[0]).not.toHaveProperty('task');
    expect(listed.agents[0]).not.toHaveProperty('tenant_id');

    const single = (await runDispatcher(dispatcher.dispatch, 'agents.get', {
      agent_id: 'd1',
    })) as { agent: Record<string, unknown> };
    expect(single.agent.id).toBe('d1');

    const missing = await dispatcher.dispatch({
      v: 1,
      id: crypto.randomUUID(),
      method: 'agents.get',
      params: { agent_id: 'nope' },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not_found');
  });

  it('includes active runs when no host is configured', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events, provider: new SlowProvider(300) });
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events), runtime });
    dispatchers.push(dispatcher);

    const started = (await runDispatcher(dispatcher.dispatch, 'runs.start', {
      input: 'slow',
      session_id: 'sess-agents',
    })) as { run_id: string; status: string };

    const listed = (await runDispatcher(dispatcher.dispatch, 'agents.list')) as {
      agents: Array<Record<string, unknown>>;
    };
    const root = listed.agents.find((agent) => agent.session_id === 'sess-agents');
    expect(root).toBeDefined();
    expect(['queued', 'running']).toContain(String(root?.state));
    expect(root?.role).toBe('main');

    await runDispatcher(dispatcher.dispatch, 'runs.cancel', { run_id: started.run_id });
  });

  it('passes result schema validation', async () => {
    const events = new MemoryEventStream();
    const dispatcher = createLocalRpcDispatcher({ hub: hubFor(events) });
    dispatchers.push(dispatcher);
    events.publish(
      event(
        'subagent.delegate.completed',
        'root',
        { delegateId: 'done', usage: { total_tokens: 3 } },
        1,
      ),
    );

    process.env.VESSEL_VALIDATE_RESULTS = '1';
    try {
      const result = await runDispatcher(dispatcher.dispatch, 'agents.list');
      expect(result.agents).toHaveLength(1);
      const single = await runDispatcher(dispatcher.dispatch, 'agents.get', {
        agent_id: 'done',
      });
      expect((single.agent as { id: string }).id).toBe('done');
    } finally {
      delete process.env.VESSEL_VALIDATE_RESULTS;
    }
  });
});
