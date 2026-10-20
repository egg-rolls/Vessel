import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AgentMessage,
  type AgentStatus,
  MemoryEventStream,
  type Transport,
} from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gw of gateways.splice(0)) gw.stop();
});

const authFor = (): GatewayAuthLike => ({
  configured: true,
  authenticate: (token) => {
    if (token === 'tenant-a') return { tenant_id: 'a', role: 'admin' };
    if (token === 'tenant-b') return { tenant_id: 'b', role: 'admin' };
    return null;
  },
});

const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

function start(options: {
  deliver?: (message: AgentMessage) => void | Promise<void>;
  spawn?: (request: { name?: string }) => Promise<AgentStatus>;
  transport?: Transport;
}): Gateway {
  const gw = createGateway({
    events: new MemoryEventStream(),
    nodeId: 'A',
    auth: authFor(),
    team: {
      nodeId: 'A',
      ...options,
    },
  });
  gateways.push(gw);
  return gw;
}

const inboundBody = (id: string, from = 'B:worker') => ({
  protocol: 1,
  node_id: 'B',
  message: {
    id,
    from,
    to: 'A:owner',
    kind: 'task',
    content: 'ping',
    ts: Date.now(),
  },
});

const inbound = (gw: Gateway, token: string, body: unknown) =>
  fetch(`${gw.url}/v1/team/messages`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });

describe('gateway dedup keys include tenant', () => {
  it('does not collide when two tenants reuse the same message id', async () => {
    const delivered: AgentMessage[] = [];
    const gw = start({
      deliver: (message) => {
        delivered.push(message);
      },
    });

    const first = await inbound(gw, 'tenant-a', inboundBody('same-id'));
    expect(first.status).toBe(202);

    const replay = await inbound(gw, 'tenant-a', inboundBody('same-id'));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduplicated?: boolean }).deduplicated).toBe(true);

    const otherTenant = await inbound(gw, 'tenant-b', inboundBody('same-id'));
    expect(otherTenant.status).toBe(202);
    expect(delivered).toHaveLength(2);
  });

  it('keys spawn idempotency by tenant + request_id', async () => {
    let spawnCount = 0;
    const gw = start({
      spawn: async () => {
        spawnCount += 1;
        return { id: `worker-${spawnCount}`, state: 'idle', toolNames: [] };
      },
    });

    const spawn = (token: string) =>
      fetch(`${gw.url}/v1/team/agents`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ request_id: 'req-1', name: 'Worker' }),
      });

    expect((await spawn('tenant-a')).status).toBe(201);
    const replay = await spawn('tenant-a');
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduplicated?: boolean }).deduplicated).toBe(true);

    expect((await spawn('tenant-b')).status).toBe(201);
    expect(spawnCount).toBe(2);
  });

  it('deduplicates local /v1/team/send by tenant + from + message id', async () => {
    const sent: AgentMessage[] = [];
    const transport: Transport = {
      kind: 'in-process',
      send: async (message) => {
        sent.push(message);
      },
      receive: () => () => undefined,
      peers: async () => [],
      close: async () => undefined,
    };
    const gw = start({ transport });

    const body = {
      protocol: 1,
      message: {
        id: 'send-1',
        from: 'A:owner',
        to: 'A:worker',
        kind: 'task',
        content: 'hello',
        ts: Date.now(),
      },
    };
    const send = (token: string) =>
      fetch(`${gw.url}/v1/team/send`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });

    expect((await send('tenant-a')).status).toBe(202);
    const replay = await send('tenant-a');
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduplicated?: boolean }).deduplicated).toBe(true);
    expect(sent).toHaveLength(1);

    // 另一个 tenant 的同 id 消息不受影响。
    expect((await send('tenant-b')).status).toBe(202);
    expect(sent).toHaveLength(2);
  });
});
