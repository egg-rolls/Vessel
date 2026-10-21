import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentMessage, AgentStatus, RunEvent } from '../../packages/core/src/index';
import { MemoryEventStream } from '../../packages/core/src/index';
import { type Gateway, startGateway } from '../../packages/serve/src/gateway';
import { NodeRegistry } from '../node-registry';
import { RemoteTransport } from '../remote-transport';

const gateways: Gateway[] = [];
const transports: RemoteTransport[] = [];

function status(): AgentStatus {
  return { id: 'worker', state: 'idle', toolNames: ['bash'] };
}

function startNodeB(): { gateway: Gateway; events: MemoryEventStream; inbound: AgentMessage[] } {
  const events = new MemoryEventStream();
  const inbound: AgentMessage[] = [];
  const gateway = startGateway({
    events,
    port: 0,
    hostname: '127.0.0.1',
    nodeId: 'node-b',
    team: {
      nodeId: 'node-b',
      host: {
        list: () => [status()],
        get: (id) =>
          id === 'worker' ? { status: () => status(), close: async () => undefined } : undefined,
        inbox: async () => ({ messages: [], cursor: '0' }),
        cancel: () => undefined,
      },
      spawn: async (request) => ({
        id: request.name ?? 'spawned',
        state: 'idle',
        toolNames: [],
      }),
      deliver: (message) => {
        inbound.push(message);
      },
    },
  });
  gateways.push(gateway);
  return { gateway, events, inbound };
}

async function startNodeA(url: string, token: string, events: RunEvent[]) {
  const registry = await NodeRegistry.create([{ id: 'node-b', url, token }], {
    heartbeatMs: 0,
  });
  const transport = new RemoteTransport({
    nodeId: 'node-a',
    registry,
    onEvent: (event) => events.push(event),
    eventReconnect: { initialMs: 5, maxMs: 10, helloTimeoutMs: 1000 },
  });
  transports.push(transport);
  transport.start();
  return transport;
}

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  for (const gateway of gateways.splice(0)) gateway.stop();
});

describe('remote transport e2e (0.6 real gateway endpoints)', () => {
  it('team.status/inbox/spawn, message delivery and event fan-out across two gateways', async () => {
    const { gateway, events: nodeEvents, inbound } = startNodeB();
    const received: RunEvent[] = [];
    const transport = await startNodeA(gateway.url, gateway.token, received);

    // B2：静态节点 + token 可访问真实 gateway 端点。
    const list = await transport.request<{ agents: Array<{ id: string; state: string }> }>(
      'node-b',
      { method: 'team.status.list' },
    );
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0]).toMatchObject({ id: 'worker', state: 'idle' });

    const one = await transport.request<{ agent: { id: string } }>('node-b', {
      method: 'team.status',
      params: { agentId: 'worker' },
    });
    expect(one.agent.id).toBe('worker');

    const inbox = await transport.request<{ agent_id: string; cursor: string }>('node-b', {
      method: 'team.inbox',
      params: { agentId: 'worker' },
    });
    expect(inbox.agent_id).toBe('worker');
    expect(inbox.cursor).toBe('0');

    const spawnRequest = {
      requestId: 'spawn-1',
      method: 'team.spawn',
      params: { name: 'new-worker', model: 'm1', systemPrompt: 'hi' },
    };
    const spawned = await transport.request<{ agent: { id: string } }>('node-b', spawnRequest);
    expect(spawned.agent.id).toBe('new-worker');

    // P1：body 携带 request_id；同 id 重试由 gateway 幂等返回 deduplicated。
    const retried = await transport.request<{ agent: { id: string }; deduplicated?: boolean }>(
      'node-b',
      spawnRequest,
    );
    expect(retried.agent.id).toBe('new-worker');
    expect(retried.deduplicated).toBe(true);

    // B1：跨节点消息（gateway 归一成本机地址后交给 deliver）。
    await transport.send({
      id: 'msg-1',
      from: 'node-a:owner',
      to: 'node-b:worker',
      kind: 'task',
      content: 'do it',
      ts: Date.now(),
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ id: 'msg-1', from: 'node-a:owner', to: 'worker' });

    // B4：远端事件经 wss/ws 扇出并带 origin node_id。
    nodeEvents.publish({
      type: 'agent.started',
      run_id: 'run-1',
      data: {},
      ts: Date.now(),
    });
    // 真实 WS 扇出；CI 慢机上 3s 偏紧，放宽到 10s（仍是有界轮询）。
    const deadline = Date.now() + 10_000;
    while (!received.some((event) => event.run_id === 'run-1')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for remote event');
      await Bun.sleep(10);
    }
    const event = received.find((item) => item.run_id === 'run-1');
    expect(event?.node_id).toBe('node-b');

    // 0.9：真实 gateway 的 hello 携带 incarnation，transport 从 hello 学到后
    // 经 peers() 暴露。旧网关（缺少该字段）的兼容路径由 fake socket 的
    // remote-transport-0.9-dedup.test.ts 覆盖，不在这里伪造。
    const peers = await transport.peers();
    const peer = peers.find((item) => item.nodeId === 'node-b');
    expect(peer).toBeDefined();
    expect(typeof peer?.incarnation).toBe('string');
    expect(peer?.incarnation).not.toBe('');
  });
});
