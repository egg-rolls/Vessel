import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { createInteractionMethods } from '../src/gateway/methods/interactions';
import { RpcError, type RpcMethodContext } from '../src/rpc';
import { createRunEngine, type RunEngine } from '../src/run-engine';

function setup(): { engine: RunEngine; seen: unknown[] } {
  const events = new MemoryEventStream();
  const engine = createRunEngine({
    tenantEventsFor: () => events,
    defaultTenantId: 'default',
  });
  const seen: unknown[] = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  return { engine, seen };
}

function requestPermission(engine: RunEngine, ts = 1_000): void {
  engine.handleEvent({
    type: 'tool.permission.request',
    run_id: 'run-1',
    ts,
    data: {
      requestId: 'perm-1',
      tool: 'bash',
      input: { cmd: 'ls' },
      session_id: 's1',
      agent_id: 'm1',
      team_id: 'team-1',
    },
  });
}

describe('permission audit attribution', () => {
  it('records policy deny_after attribution and latency from stream responses', () => {
    const { engine } = setup();
    requestPermission(engine, 1_000);
    engine.handleEvent({
      type: 'tool.permission.response',
      run_id: 'run-1',
      ts: 1_450,
      data: {
        requestId: 'perm-1',
        decision: 'deny',
        scope: 'once',
        session_id: 's1',
        answered_by: 'policy',
        answered_via: 'policy',
        policy: 'deny_after',
      },
    });

    const record = engine.interactionRecords.get('perm-1');
    expect(record).toMatchObject({ status: 'answered', agent_id: 'm1', team_id: 'team-1' });
    expect(record?.answer).toMatchObject({
      decision: 'deny',
      scope: 'once',
      answered_at: 1_450,
      answered_by: 'policy',
      answered_via: 'policy',
      policy: 'deny_after',
      latency_ms: 450,
    });
    expect(engine.pendingPermissions.has('perm-1')).toBe(false);
  });

  it('ignores an agent-originated response and leaves the request pending', () => {
    const { engine } = setup();
    requestPermission(engine);
    engine.handleEvent({
      type: 'tool.permission.response',
      run_id: 'run-1',
      ts: Date.now(),
      data: { requestId: 'perm-1', decision: 'allow', answered_by: 'agent' },
    });

    const record = engine.interactionRecords.get('perm-1');
    expect(record?.status).toBe('pending');
    expect(record?.answer).toBeUndefined();
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);
  });

  it('treats a legacy response without answered_by as human', () => {
    const { engine } = setup();
    requestPermission(engine);
    engine.handleEvent({
      type: 'tool.permission.response',
      run_id: 'run-1',
      ts: Date.now(),
      data: { requestId: 'perm-1', decision: 'allow', scope: 'once' },
    });

    expect(engine.interactionRecords.get('perm-1')?.answer).toMatchObject({
      decision: 'allow',
      scope: 'once',
      answered_by: 'human',
    });
  });

  it('records RPC answers as human via rpc', () => {
    const { engine } = setup();
    requestPermission(engine);
    const result = engine.respondPermission('perm-1', 'allow', false, undefined, 'once', {
      answered_by: 'human',
      answered_via: 'rpc',
    });

    expect(result).toMatchObject({ answered_by: 'human', answered_via: 'rpc' });
    expect(typeof result.latency_ms).toBe('number');
    expect(engine.interactionRecords.get('perm-1')?.answer).toMatchObject({
      decision: 'allow',
      scope: 'once',
      answered_by: 'human',
      answered_via: 'rpc',
    });
  });
});

function context(teamId: string): RpcMethodContext {
  return {
    principal: { tenant_id: 'default', role: 'write', scope: 'control', team_id: teamId },
    tenantId: 'default',
    isAdmin: false,
    allTenants: false,
    connection: 'http',
  };
}

describe('team access uses record.team_id before session mapping', () => {
  it('allows the record team even when the session mapping is unavailable', () => {
    const { engine } = setup();
    requestPermission(engine);
    const handled: string[] = [];
    const methods = createInteractionMethods({
      respondPermission: (requestId, decision) => {
        handled.push(requestId);
        return { ok: true, decision, scope: 'once' };
      },
      respondAsk: () => {},
      interactions: {
        interactionRecords: engine.interactionRecords,
        pendingPermissions: engine.pendingPermissions,
        pendingAsks: engine.pendingAsks,
      },
      // session -> team 映射不可用：只能靠 record.team_id。
      teamScope: { teamForSession: () => undefined },
    });
    const byName = new Map(methods.map((method) => [method.name, method]));

    const respond = byName.get('permission.respond');
    expect(respond).toBeDefined();
    respond?.handler({ request_id: 'perm-1', decision: 'allow' }, context('team-1'));
    expect(handled).toEqual(['perm-1']);

    expect(() =>
      respond?.handler({ request_id: 'perm-1', decision: 'allow' }, context('team-2')),
    ).toThrow(RpcError);

    const list = byName.get('interactions.list');
    expect(list).toBeDefined();
    const listed = list?.handler({}, context('team-1')) as {
      interactions: Array<{ request_id: string }>;
    };
    expect(listed.interactions.map((item) => item.request_id)).toEqual(['perm-1']);
    const other = list?.handler({}, context('team-2')) as {
      interactions: Array<{ request_id: string }>;
    };
    expect(other.interactions).toEqual([]);
  });
});
