import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentMessage, AgentStatus, InboxPage } from '@vessel/core';
import { MemoryEventStream } from '@vessel/core';
import { type Gateway, startGateway } from '../src/gateway';
import type { TeamHostLike, TeamSpawnRequest } from '../src/team';

describe('gateway /v1/team agents & inbox', () => {
  const gateways: Gateway[] = [];

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  function makeHost() {
    const statuses = new Map<string, AgentStatus>();
    const inboxes = new Map<string, AgentMessage[]>();
    const closed = new Set<string>();
    const host: TeamHostLike = {
      list: () => [...statuses.values()],
      get: (id) => {
        const status = statuses.get(id);
        if (!status) return undefined;
        return {
          status: () => status,
          close: async () => {
            closed.add(id);
            statuses.delete(id);
          },
        };
      },
      inbox: async (id, cursor = '0'): Promise<InboxPage> => {
        const all = inboxes.get(id) ?? [];
        const start = Math.max(0, Number.parseInt(cursor, 10) || 0);
        return { messages: all.slice(start), cursor: String(all.length) };
      },
      cancel: (id) => {
        const status = statuses.get(id);
        if (status) statuses.set(id, { ...status, state: 'cancelled' });
      },
    };
    const spawn = async (request: TeamSpawnRequest): Promise<AgentStatus> => {
      const status: AgentStatus = {
        id: 'worker',
        ...(request.name !== undefined ? { name: request.name } : {}),
        state: 'idle',
        toolNames: ['read'],
      };
      statuses.set('worker', status);
      return status;
    };
    const deliver = (message: AgentMessage): void => {
      const list = inboxes.get(message.to) ?? [];
      list.push(message);
      inboxes.set(message.to, list);
    };
    return { host, spawn, deliver, statuses, inboxes, closed };
  }

  const auth = (gw: Gateway) => ({ Authorization: `Bearer ${gw.token}` });
  const jsonHeaders = (gw: Gateway) => ({
    ...auth(gw),
    'Content-Type': 'application/json',
  });

  it('lists/spawns/reads/cancels/closes members', async () => {
    const { host, spawn } = makeHost();
    const gw = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      nodeId: 'A',
      team: { nodeId: 'A', host, spawn },
    });
    gateways.push(gw);

    const empty = (await (
      await fetch(`${gw.url}/v1/team/agents`, { headers: auth(gw) })
    ).json()) as {
      agents: unknown[];
    };
    expect(empty.agents).toEqual([]);

    const spawned = await fetch(`${gw.url}/v1/team/agents`, {
      method: 'POST',
      headers: jsonHeaders(gw),
      body: JSON.stringify({ name: 'Worker', system_prompt: 'be nice' }),
    });
    expect(spawned.status).toBe(201);
    const spawnedBody = (await spawned.json()) as {
      agent: { id: string; name: string; tool_names: string[] };
    };
    expect(spawnedBody.agent.id).toBe('worker');
    expect(spawnedBody.agent.name).toBe('Worker');
    expect(spawnedBody.agent.tool_names).toEqual(['read']);

    const status = await fetch(`${gw.url}/v1/team/agents/worker`, { headers: auth(gw) });
    expect(status.status).toBe(200);

    const cancelled = await fetch(`${gw.url}/v1/team/agents/worker/cancel`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(cancelled.status).toBe(200);
    const cancelledBody = (await cancelled.json()) as { cancelled: boolean };
    expect(cancelledBody.cancelled).toBe(true);

    const remoteCancel = await fetch(`${gw.url}/v1/team/agents/B:worker/cancel`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(remoteCancel.status).toBe(400);
    const remoteBody = (await remoteCancel.json()) as { error: { code: string } };
    expect(remoteBody.error.code).toBe('remote_cancel_not_supported');

    const closed = await fetch(`${gw.url}/v1/team/agents/worker/close`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(closed.status).toBe(200);
    const missing = await fetch(`${gw.url}/v1/team/agents/worker`, { headers: auth(gw) });
    expect(missing.status).toBe(404);
  });

  it('delivers inbound messages and paginates the inbox', async () => {
    const { host, deliver } = makeHost();
    const gw = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      nodeId: 'A',
      team: { nodeId: 'A', host, deliver },
    });
    gateways.push(gw);

    const post = (id: string) =>
      fetch(`${gw.url}/v1/team/messages`, {
        method: 'POST',
        headers: jsonHeaders(gw),
        body: JSON.stringify({
          protocol: 1,
          node_id: 'B',
          message: {
            id,
            from: 'B:owner',
            to: 'A:worker',
            kind: 'task',
            content: id,
            ts: Date.now(),
          },
        }),
      });

    expect((await post('m1')).status).toBe(202);
    expect((await post('m2')).status).toBe(202);
    // duplicate: accepted but not re-delivered
    expect((await post('m2')).status).toBe(200);

    const inbox = await fetch(`${gw.url}/v1/team/inbox?agent_id=worker&cursor=0`, {
      headers: auth(gw),
    });
    expect(inbox.status).toBe(200);
    const body = (await inbox.json()) as {
      messages: Array<{ id: string; reply_to?: string }>;
      cursor: string;
    };
    expect(body.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(body.cursor).toBe('2');

    const page2 = await fetch(`${gw.url}/v1/team/inbox?agent_id=worker&cursor=2`, {
      headers: auth(gw),
    });
    const page2Body = (await page2.json()) as { messages: unknown[] };
    expect(page2Body.messages).toEqual([]);
  });

  it('reports no_host / no_spawn when handlers are absent', async () => {
    const gw = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      nodeId: 'A',
      team: { nodeId: 'A' },
    });
    gateways.push(gw);

    const inbox = await fetch(`${gw.url}/v1/team/inbox?agent_id=worker`, { headers: auth(gw) });
    expect(inbox.status).toBe(400);
    expect(((await inbox.json()) as { error: { code: string } }).error.code).toBe('no_host');

    const spawn = await fetch(`${gw.url}/v1/team/agents`, {
      method: 'POST',
      headers: jsonHeaders(gw),
      body: JSON.stringify({}),
    });
    expect(spawn.status).toBe(400);
    expect(((await spawn.json()) as { error: { code: string } }).error.code).toBe('no_spawn');
  });
});
