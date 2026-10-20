import { afterEach, describe, expect, it } from 'bun:test';
import { type AgentStatus, MemoryEventStream, type RunEvent } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import type { TeamGatewayOptions, TeamHostLike, TeamSpawnRequest } from '../src/team';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: '*', role: 'admin' },
    b: { tenant_id: 'b', role: 'write' },
    d: { tenant_id: 'default', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function makeHost(): TeamHostLike {
  const status: AgentStatus = {
    id: 'worker',
    name: 'Worker',
    state: 'idle',
    toolNames: ['read'],
  };
  return {
    list: () => [status],
    get: (id) =>
      id === 'worker'
        ? {
            status: () => status,
            close: async () => undefined,
          }
        : undefined,
    inbox: async (_id, cursor = '0') => ({ messages: [], cursor }),
    cancel: () => undefined,
  };
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({
  ...authHeaders(token),
  'Content-Type': 'application/json',
});

afterEach(() => {
  for (const gw of gateways.splice(0)) gw.stop();
});

describe('gateway /v1/team remote boundary', () => {
  const setup = (
    overrides: Partial<TeamGatewayOptions> = {},
    spawn?: (request: TeamSpawnRequest) => Promise<AgentStatus>,
  ): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      nodeId: 'A',
      auth: authFor(),
      team: {
        nodeId: 'A',
        host: makeHost(),
        ...(spawn ? { spawn } : {}),
        ...overrides,
      },
    });
    gateways.push(gw);
    return gw;
  };

  it('restricts the team control plane to default tenant or admin', async () => {
    const gw = setup();
    const denied = await fetch(`${gw.url}/v1/team/agents`, {
      headers: authHeaders('b'),
    });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as {
      error: { code: string; message: string };
    };
    expect(deniedBody.error.code).toBe('forbidden');
    expect(typeof deniedBody.error.message).toBe('string');
    expect(Object.keys(deniedBody.error).sort()).toEqual(['code', 'message']);

    expect((await fetch(`${gw.url}/v1/team/agents`, { headers: authHeaders('d') })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${gw.url}/v1/team/agents`, { headers: authHeaders('admin') })).status,
    ).toBe(200);
  });

  it('deduplicates spawn by request_id including concurrent calls', async () => {
    let spawnCount = 0;
    const gw = setup({}, async (request) => {
      spawnCount += 1;
      return {
        id: `worker-${spawnCount}`,
        ...(request.name !== undefined ? { name: request.name } : {}),
        state: 'idle',
        toolNames: ['read'],
      };
    });

    const spawn = (requestId: unknown) =>
      fetch(`${gw.url}/v1/team/agents`, {
        method: 'POST',
        headers: jsonHeaders('d'),
        body: JSON.stringify({ request_id: requestId, name: 'Worker' }),
      });

    const first = await spawn('req-1');
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { agent: { id: string; tool_names: string[] } };
    expect(firstBody.agent.id).toBe('worker-1');
    expect(firstBody.agent.tool_names).toEqual(['read']);

    const second = await spawn('req-1');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      agent: { id: string };
      deduplicated: boolean;
    };
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.agent.id).toBe('worker-1');
    expect(spawnCount).toBe(1);

    const concurrent = await Promise.all([spawn('req-2'), spawn('req-2')]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(spawnCount).toBe(2);

    const invalid = await spawn(123);
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as { error: { code: string; message: string } };
    expect(invalidBody.error.code).toBe('invalid_request');
  });

  it('carries the source node_id on team.event frames', async () => {
    const events = new MemoryEventStream();
    const gw = createGateway({
      events,
      nodeId: 'A',
      auth: authFor(),
      team: { nodeId: 'A' },
    });
    gateways.push(gw);

    const res = await fetch(`${gw.url}/v1/team/stream`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();

    events.publish({
      type: 'team.peer.joined',
      run_id: 'team',
      data: { nodeId: 'B' },
      ts: Date.now(),
      node_id: 'B',
    } as RunEvent);

    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes('"kind":"team.event"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();

    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    const teamEvent = frames.find((frame) => frame.kind === 'team.event');
    expect(teamEvent?.node_id).toBe('B');
    expect((teamEvent?.event as { data?: { node_id?: string } } | undefined)?.data?.node_id).toBe(
      'B',
    );
  });
});
