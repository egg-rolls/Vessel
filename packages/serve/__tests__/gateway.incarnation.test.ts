import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type Transport } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { TeamGatewayOptions } from '../src/team';
import { createGateway, TestWs } from './helpers';

const gateways: Gateway[] = [];
const INCARNATION = /^[0-9a-f]{12}$/;

afterEach(() => {
  for (const gw of gateways.splice(0)) gw.stop();
});

function start(team: TeamGatewayOptions): Gateway {
  const gw = createGateway({
    events: new MemoryEventStream(),
    nodeId: 'A',
    team,
  });
  gateways.push(gw);
  return gw;
}

describe('gateway incarnation', () => {
  it('includes the process incarnation in every WS hello', async () => {
    const gw = start({ nodeId: 'A' });

    const first = await TestWs.connect(gw);
    const firstHello = await first.next((frame) => frame.kind === 'hello');
    first.close();
    const second = await TestWs.connect(gw);
    const secondHello = await second.next((frame) => frame.kind === 'hello');
    second.close();

    if (firstHello.kind !== 'hello' || secondHello.kind !== 'hello') {
      throw new Error('expected hello frames');
    }
    expect(firstHello.incarnation).toMatch(INCARNATION);
    expect(secondHello.incarnation).toBe(firstHello.incarnation);
  });

  it('exposes peer incarnation on /v1/team/peers and omits it when absent', async () => {
    const transport: Transport = {
      kind: 'in-process',
      send: async () => undefined,
      receive: () => () => undefined,
      peers: async () => [
        {
          nodeId: 'B',
          endpoint: 'http://b',
          agents: [],
          protocol: 1,
          incarnation: 'inc-b',
        },
        { nodeId: 'C', endpoint: 'http://c', agents: [], protocol: 1 },
      ],
      close: async () => undefined,
    };
    const gw = start({ nodeId: 'A', transport });

    const res = await fetch(`${gw.url}/v1/team/peers`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      peers: Array<{ node_id: string; incarnation?: string; protocol: number }>;
    };
    const peerB = body.peers.find((peer) => peer.node_id === 'B');
    const peerC = body.peers.find((peer) => peer.node_id === 'C');
    expect(peerB?.incarnation).toBe('inc-b');
    expect(peerB?.protocol).toBe(1);
    expect(peerC).toBeDefined();
    expect(peerC !== undefined && 'incarnation' in peerC).toBe(false);
  });

  it('reports the same incarnation for the self peer and WS hello', async () => {
    const gw = start({ nodeId: 'A' });

    const ws = await TestWs.connect(gw);
    const hello = await ws.next((frame) => frame.kind === 'hello');
    ws.close();
    if (hello.kind !== 'hello') throw new Error('expected hello frame');

    const res = await fetch(`${gw.url}/v1/team/peers`, {
      headers: { Authorization: `Bearer ${gw.token}` },
    });
    const body = (await res.json()) as {
      peers: Array<{ node_id: string; incarnation?: string }>;
    };
    const self = body.peers.find((peer) => peer.node_id === 'A');
    expect(self?.incarnation).toBe(hello.incarnation);
    expect(self?.incarnation).toMatch(INCARNATION);
  });
});
