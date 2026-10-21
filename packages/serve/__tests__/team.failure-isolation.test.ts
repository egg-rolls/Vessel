import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentMessage, PeerInfo, RunEvent, Transport, Unsubscribe } from '@vessel-agent/core';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createRuntime, startTestGateway as startGateway, waitUntil } from './helpers';

/** 一个所有跨节点操作都失败的 Transport */
class BrokenTransport implements Transport {
  readonly kind = 'loopback' as const;

  async send(_message: AgentMessage): Promise<void> {
    const error = new Error('peer unreachable') as Error & { code: string };
    error.code = 'peer_unreachable';
    throw error;
  }

  receive(_handler: (message: AgentMessage) => void): Unsubscribe {
    return () => {};
  }

  async peers(): Promise<PeerInfo[]> {
    throw new Error('registry unavailable');
  }

  async close(): Promise<void> {}
}

describe('team failure isolation', () => {
  const gateways: Gateway[] = [];

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('keeps v1 endpoints working when the transport is broken', async () => {
    const events = new MemoryEventStream();
    const published: RunEvent[] = [];
    events.subscribe((event) => {
      published.push(event);
    });
    const runtime = await createRuntime({ events });
    const gw = startGateway({
      events,
      runtime,
      port: 0,
      nodeId: 'A',
      team: { nodeId: 'A', transport: new BrokenTransport() },
    });
    gateways.push(gw);

    // v1 健康检查与运行不受影响
    expect((await fetch(`${gw.url}/v1/health`)).status).toBe(200);
    const run = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gw.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: 'still works' }),
    });
    expect(run.status).toBe(202);
    const body = (await run.json()) as { run_id: string };
    await waitUntil(async () => {
      const status = await fetch(`${gw.url}/v1/runs/${body.run_id}`, {
        headers: { Authorization: `Bearer ${gw.token}` },
      });
      return ((await status.json()) as { status: string }).status === 'completed';
    });

    // peers 失败降级为自身，不 500
    const peers = await fetch(`${gw.url}/v1/team/peers`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(peers.status).toBe(200);
    const peersBody = (await peers.json()) as { peers: Array<{ node_id: string }> };
    expect(peersBody.peers.map((peer) => peer.node_id)).toEqual(['A']);

    // outbound 失败返回结构化错误，并发布 team.transport.error
    const send = await fetch(`${gw.url}/v1/team/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gw.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 1,
        message: {
          id: 'fail-1',
          from: 'A:owner',
          to: 'B:worker',
          kind: 'task',
          content: 'x',
          ts: Date.now(),
        },
      }),
    });
    expect(send.status).toBe(502);
    const sendBody = (await send.json()) as { error: { code: string } };
    expect(sendBody.error.code).toBe('peer_unreachable');
    expect(published.some((event) => event.type === 'team.transport.error')).toBe(true);
  });
});
