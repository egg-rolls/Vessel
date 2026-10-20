/**
 * 0.9 Wave 2B2B C：跨节点去重键（incarnation / run_id / from+id）。
 */

import { describe, expect, it } from 'bun:test';
import type { TransportNodeConfig } from '../../packages/config/src/index';
import type { AgentMessage, RunEvent } from '../../packages/core/src/index';
import { NodeRegistry } from '../node-registry';
import { RemoteTransport } from '../remote-transport';
import type { WebSocketLike } from '../rpc/index';

type FetchLike = typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NODES: TransportNodeConfig[] = [
  { id: 'node-b', url: 'http://127.0.0.1:9001', token: 'tok-b' },
  { id: 'node-c', url: 'https://node-c.example.com', token: 'tok-c' },
];

class FakeSocket {
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }

  auth(): Record<string, unknown> {
    return JSON.parse(this.sent[0] ?? '{}') as Record<string, unknown>;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

async function makeTransport(options: {
  onEvent?: (event: RunEvent) => void;
  incarnation?: string;
}): Promise<{ transport: RemoteTransport; sockets: FakeSocket[] }> {
  const fetchImpl = (async () => jsonResponse({})) as unknown as FetchLike;
  const registry = await NodeRegistry.create(NODES, { env: {}, fetch: fetchImpl, heartbeatMs: 0 });
  const sockets: FakeSocket[] = [];
  const transport = new RemoteTransport({
    nodeId: 'node-a',
    registry,
    fetch: fetchImpl,
    ...(options.incarnation !== undefined ? { incarnation: options.incarnation } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    webSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    eventReconnect: { initialMs: 1, maxMs: 2, helloTimeoutMs: 1000 },
  });
  return { transport, sockets };
}

function localMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'm1',
    from: 'node-a:owner',
    to: 'worker',
    kind: 'message',
    content: 'hi',
    ts: 1,
    ...overrides,
  };
}

function eventFrame(nodeId: string, seq: number, runId: string): string {
  return JSON.stringify({
    kind: 'event',
    node_id: nodeId,
    seq,
    event: { type: 'agent.started', run_id: runId, data: {}, ts: 1 },
  });
}

describe('RemoteTransport 0.9 消息去重键', () => {
  it('本机 send 与入站共用 from+id：重放一次、不同 from 同 id 都投递', async () => {
    const { transport } = await makeTransport({});
    const received: AgentMessage[] = [];
    transport.receive((message) => {
      received.push(message);
    });

    await transport.send(localMessage());
    await transport.send(localMessage());
    await transport.send(localMessage({ to: '*' }));
    expect(received).toHaveLength(1);

    // 同一 id、不同发送方 → 不同键，都投递。
    await transport.send(localMessage({ from: 'node-a:other' }));
    expect(received).toHaveLength(2);

    // 入站路径共享同一集合：本机已投递过的 from+id 不再重复。
    expect(await transport.deliver(localMessage())).toBe(false);
    expect(await transport.deliver(localMessage({ from: 'node-b:worker' }))).toBe(true);
    expect(received).toHaveLength(3);

    await transport.close();
  });
});

describe('RemoteTransport 0.9 事件去重键', () => {
  it('事件键含 run_id：同节点同 seq、不同 run 都投递；重复帧仍去重', async () => {
    const events: RunEvent[] = [];
    const { transport, sockets } = await makeTransport({
      onEvent: (event) => events.push(event),
    });
    transport.start();

    const b = sockets.find((socket) => socket.url.includes('127.0.0.1:9001'));
    b?.emit('open');
    b?.emitMessage(
      JSON.stringify({ kind: 'hello', node_id: 'node-b', latest_seq: 0, incarnation: 'inc-b1' }),
    );

    b?.emitMessage(eventFrame('node-b', 6, 'run-1'));
    b?.emitMessage(eventFrame('node-b', 6, 'run-1'));
    expect(events.map((event) => event.run_id)).toEqual(['run-1']);

    // 同一 seq 复用于另一个 run：键含 run_id，不能被旧键吞掉。
    b?.emitMessage(eventFrame('node-b', 6, 'run-2'));
    expect(events.map((event) => event.run_id)).toEqual(['run-1', 'run-2']);

    await transport.close();
  });

  it('hello 缺 incarnation（旧网关）不崩：仍按 - 去重；auth 帧带本端代际', async () => {
    const events: RunEvent[] = [];
    const { transport, sockets } = await makeTransport({
      onEvent: (event) => events.push(event),
      incarnation: 'inc-local',
    });
    transport.start();

    const c = sockets.find((socket) => socket.url.startsWith('wss://node-c.example.com'));
    c?.emit('open');
    expect(c?.auth()).toMatchObject({ kind: 'auth', token: 'tok-c', incarnation: 'inc-local' });

    // 旧网关 hello 没有 incarnation：视为 '-'，订阅继续工作。
    c?.emitMessage(JSON.stringify({ kind: 'hello', node_id: 'node-c', latest_seq: 0 }));
    c?.emitMessage(eventFrame('node-c', 1, 'run-x'));
    c?.emitMessage(eventFrame('node-c', 1, 'run-x'));
    await waitFor(() => events.length === 1);
    expect(events[0]?.run_id).toBe('run-x');
    await Bun.sleep(10);
    expect(events).toHaveLength(1);

    // peer 记录不带伪造代际。
    const peer = (await transport.peers()).find((item) => item.nodeId === 'node-c');
    expect(peer?.incarnation).toBeUndefined();

    await transport.close();
  });

  it('incarnation 变化只清该节点键，其它节点键保留', async () => {
    const events: RunEvent[] = [];
    const { transport, sockets } = await makeTransport({
      onEvent: (event) => events.push(event),
    });
    transport.start();

    const b = sockets.find((socket) => socket.url.includes('127.0.0.1:9001'));
    const c = sockets.find((socket) => socket.url.startsWith('wss://node-c.example.com'));

    b?.emit('open');
    b?.emitMessage(
      JSON.stringify({ kind: 'hello', node_id: 'node-b', latest_seq: 0, incarnation: 'inc-b1' }),
    );
    c?.emit('open');
    c?.emitMessage(
      JSON.stringify({ kind: 'hello', node_id: 'node-c', latest_seq: 0, incarnation: 'inc-c1' }),
    );

    b?.emitMessage(eventFrame('node-b', 1, 'run-1'));
    c?.emitMessage(eventFrame('node-c', 1, 'run-1'));
    expect(events.map((event) => event.node_id)).toEqual(['node-b', 'node-c']);

    // node-b 代际变化：只清 node-b 的键，旧键不再吞事件。
    // latest_seq 不回调，避免触发 seq 回退重连（那是另一条路径，0.6 已覆盖）。
    b?.emitMessage(
      JSON.stringify({ kind: 'hello', node_id: 'node-b', latest_seq: 10, incarnation: 'inc-b2' }),
    );
    b?.emitMessage(eventFrame('node-b', 1, 'run-1'));
    expect(events.map((event) => event.node_id)).toEqual(['node-b', 'node-c', 'node-b']);

    // node-c 未换代：同一键仍然去重。
    c?.emitMessage(eventFrame('node-c', 1, 'run-1'));
    expect(events).toHaveLength(3);

    // hello 学到的代际随 peers() 传播。
    const peers = await transport.peers();
    expect(peers.find((peer) => peer.nodeId === 'node-b')?.incarnation).toBe('inc-b2');
    expect(peers.find((peer) => peer.nodeId === 'node-c')?.incarnation).toBe('inc-c1');

    await transport.close();
  });
});
