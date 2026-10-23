import { describe, expect, it } from 'bun:test';
import {
  createHubControlClient,
  type HubControlClient,
  type HubControlPointer,
  type HubControlSnapshot,
  type HubControlStatus,
} from '../hub/control-client';
import type { HubNodeRecord } from '../hub/types';
import type { WebSocketFactory, WebSocketLike } from '../rpc/index';

type Listener = (event?: unknown) => void;

/** 无网络的 WebSocket 替身：测试手动触发 open / message / close。 */
class FakeSocket {
  readonly url: string;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  readyState = 1;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.emit('open');
  }

  message(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  serverClose(code: number): void {
    this.closed = true;
    this.emit('close', { code });
  }

  lastFrame(): Record<string, unknown> {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error('no frame sent');
    return JSON.parse(last) as Record<string, unknown>;
  }
}

const HUB_ID = 'hub-1';

function makeRecord(overrides: Partial<HubNodeRecord> = {}): HubNodeRecord {
  return {
    pairing_id: 'node-1:tenant-1',
    node_id: 'node-1',
    tenant_id: 'tenant-1',
    url: 'http://127.0.0.1:8642',
    status: 'connecting',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

function helloFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'hello',
    protocol: 'vessel.hub/1',
    dialer: 'node',
    node_id: 'node-1',
    hub_id: HUB_ID,
    incarnation: 'inc-1',
    revision: 0,
    tenant_id: 'tenant-1',
    ...overrides,
  };
}

function snapshotFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'snapshot',
    protocol: 'vessel.hub/1',
    dialer: 'node',
    node_id: 'node-1',
    hub_id: HUB_ID,
    incarnation: 'inc-1',
    revision: 1,
    observed_at: 1234,
    truncated: false,
    counts: { teams: 1, agents: 1, live_agents: 1 },
    teams: [{ team_id: 'team-1', name: 'Team One', member_count: 1, agent_count: 1 }],
    agents: [
      {
        agent_id: 'agent-1',
        team_id: 'team-1',
        membership: 'present',
        presence: 'live',
      },
    ],
    ...overrides,
  };
}

interface Harness {
  client: HubControlClient;
  socket: FakeSocket;
  snapshots: HubControlSnapshot[];
  pointers: HubControlPointer[];
  statuses: HubControlStatus[];
}

function harness(recordOverrides: Partial<HubNodeRecord> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const snapshots: HubControlSnapshot[] = [];
  const pointers: HubControlPointer[] = [];
  const statuses: HubControlStatus[] = [];

  const wsFactory: WebSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocketLike;
  };

  const client = createHubControlClient({
    record: makeRecord(recordOverrides),
    viewToken: 'view-token',
    hubId: HUB_ID,
    wsFactory,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onPointer: (pointer) => pointers.push(pointer),
    onStatus: (status) => statuses.push(status),
    helloTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    reconnect: { initialMs: 60_000, maxMs: 60_000 },
  });

  const socket = sockets[0];
  if (!socket) throw new Error('control client did not open a socket');
  return { client, socket, snapshots, pointers, statuses };
}

describe('createHubControlClient', () => {
  it('opens the control URL and sends the auth frame first', () => {
    const { socket, client } = harness();
    expect(socket.url).toBe('ws://127.0.0.1:8642/v1/hub/control');

    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(socket.lastFrame()).toEqual({
      v: 1,
      kind: 'auth',
      protocol: 'vessel.hub/1',
      dialer: 'hub',
      token: 'view-token',
      hub_id: HUB_ID,
    });
    client.close();
  });

  it('accepts a snapshot after hello', () => {
    const { socket, snapshots, statuses, client } = harness();
    socket.open();
    socket.message(helloFrame());
    socket.message(snapshotFrame({ revision: 3 }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(3);
    expect(snapshots[0]?.counts).toEqual({ teams: 1, agents: 1, live_agents: 1 });
    expect(snapshots[0]?.teams[0]?.team_id).toBe('team-1');
    expect(statuses).toContain('healthy');
    client.close();
  });

  it('drops stale revisions', () => {
    const { socket, snapshots, client } = harness({ incarnation: 'inc-1', revision: 4 });
    socket.open();
    socket.message(helloFrame());
    // 与已保存 revision 相同 → 丢弃。
    socket.message(snapshotFrame({ revision: 4 }));
    expect(snapshots).toHaveLength(0);
    socket.message(snapshotFrame({ revision: 5 }));
    expect(snapshots).toHaveLength(1);
    // 旧包 → 丢弃。
    socket.message(snapshotFrame({ revision: 3 }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(5);
    client.close();
  });

  it('accepts a lower revision after the incarnation changes', () => {
    const { socket, snapshots, client } = harness({ incarnation: 'inc-old', revision: 42 });
    socket.open();
    socket.message(helloFrame({ incarnation: 'inc-new' }));
    // 节点重启后 revision 从 0 开始；必须无条件接受并重置比较。
    socket.message(snapshotFrame({ incarnation: 'inc-new', revision: 0 }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(0);
    client.close();
  });

  it('marks identity_mismatch when hello.node_id differs', () => {
    const { socket, snapshots, statuses, client } = harness();
    socket.open();
    socket.message(helloFrame({ node_id: 'node-2' }));
    expect(statuses).toContain('identity_mismatch');
    expect(snapshots).toHaveLength(0);
    expect(socket.closed).toBe(true);
    client.close();
  });

  it('marks identity_mismatch when hello.hub_id differs', () => {
    const { socket, statuses, client } = harness();
    socket.open();
    socket.message(helloFrame({ hub_id: 'hub-2' }));
    expect(statuses).toContain('identity_mismatch');
    expect(socket.closed).toBe(true);
    client.close();
  });

  it('marks identity_mismatch when snapshot.node_id differs', () => {
    const { socket, snapshots, statuses, client } = harness();
    socket.open();
    socket.message(helloFrame());
    socket.message(snapshotFrame({ node_id: 'node-2' }));
    expect(statuses).toContain('identity_mismatch');
    expect(snapshots).toHaveLength(0);
    client.close();
  });

  it('maps 4401 to unauthorized', () => {
    const { socket, statuses, client } = harness();
    socket.open();
    socket.serverClose(4401);
    expect(statuses).toContain('unauthorized');
    client.close();
  });

  it('maps 4400 to incompatible', () => {
    const { socket, statuses, client } = harness();
    socket.open();
    socket.serverClose(4400);
    expect(statuses).toContain('incompatible');
    client.close();
  });

  it('forwards pointers and replies to ping with pong', () => {
    const { socket, pointers, client } = harness();
    socket.open();
    socket.message(helloFrame());
    socket.message({
      v: 1,
      kind: 'pointer',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      node_id: 'node-1',
      hub_id: HUB_ID,
      team_id: 'team-1',
      request_id: 'req-1',
      reason: 'team.message',
      ts: 777,
    });
    expect(pointers).toEqual([
      {
        node_id: 'node-1',
        hub_id: HUB_ID,
        team_id: 'team-1',
        request_id: 'req-1',
        reason: 'team.message',
        ts: 777,
      },
    ]);

    socket.message({
      v: 1,
      kind: 'ping',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      ts: 888,
    });
    expect(socket.lastFrame()).toEqual({
      v: 1,
      kind: 'pong',
      protocol: 'vessel.hub/1',
      dialer: 'hub',
    });
    client.close();
  });

  it('close is idempotent', () => {
    const { client } = harness();
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
