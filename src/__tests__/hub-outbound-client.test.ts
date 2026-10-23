import { describe, expect, it } from 'bun:test';
import type { HubControlChange, HubControlLike, HubNodeSnapshotInput } from '@vessel-agent/serve';
import type { HubNodeOutboundStatus } from '../hub/node-state';
import {
  createHubNodeOutboundClient,
  type HubNodeOutboundClient,
  type HubNodeOutboundOptions,
} from '../hub/outbound-client';
import type { HubNodeState } from '../hub/types';
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
const NODE_ID = 'node-1';
const TENANT_ID = 'tenant-1';
const NOW = 1_700_000_000_000;

class FakeControl implements HubControlLike {
  snapshotCalls = 0;
  subscribeCalls = 0;
  unsubscribed = 0;
  listener: ((change: HubControlChange) => void) | undefined;
  teams: HubNodeSnapshotInput['teams'] = [
    { team_id: 'team-1', name: 'Team One', member_count: 1, agent_count: 1 },
  ];

  async snapshot(_tenantId: string): Promise<HubNodeSnapshotInput> {
    this.snapshotCalls += 1;
    return {
      counts: { teams: this.teams.length, agents: 0, live_agents: 0 },
      teams: this.teams,
      agents: [],
      truncated: false,
    };
  }

  subscribe(_tenantId: string, listener: (change: HubControlChange) => void): () => void {
    this.subscribeCalls += 1;
    this.listener = listener;
    return () => {
      this.unsubscribed += 1;
    };
  }
}

function makeState(overrides: Partial<HubNodeState> = {}): HubNodeState {
  return {
    v: 1,
    hub_url: 'http://127.0.0.1:8643',
    hub_id: HUB_ID,
    node_id: NODE_ID,
    tenant_id: TENANT_ID,
    pairing_id: `${NODE_ID}:${TENANT_ID}`,
    token_id: 'token-id-1',
    expires_at: 1_800_000_000_000,
    joined_at: 1_700_000_000_000,
    ...overrides,
  };
}

function helloFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'hello',
    protocol: 'vessel.hub/1',
    dialer: 'node',
    hub_id: HUB_ID,
    node_id: NODE_ID,
    tenant_id: TENANT_ID,
    ...overrides,
  };
}

function pingFrame(): Record<string, unknown> {
  return { v: 1, kind: 'ping', protocol: 'vessel.hub/1', dialer: 'node', ts: 5 };
}

interface StatusEvent {
  status: HubNodeOutboundStatus;
  error?: string;
}

interface Harness {
  client: HubNodeOutboundClient;
  control: FakeControl;
  sockets: FakeSocket[];
  socket: FakeSocket;
  statuses: StatusEvent[];
  helloCount: () => number;
}

function harness(overrides: Partial<HubNodeOutboundOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const statuses: StatusEvent[] = [];
  const control = new FakeControl();
  let hellos = 0;

  const wsFactory: WebSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocketLike;
  };

  const client = createHubNodeOutboundClient({
    state: makeState(),
    token: 'node-token',
    hubControl: control,
    hubId: HUB_ID,
    nodeId: NODE_ID,
    tenantId: TENANT_ID,
    hubUrl: 'http://127.0.0.1:8643',
    wsFactory,
    now: () => NOW,
    onStatus: (status, error) => {
      statuses.push(error === undefined ? { status } : { status, error });
    },
    onHello: () => {
      hellos += 1;
    },
    helloTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    reconnect: { initialMs: 60_000, maxMs: 60_000 },
    ...overrides,
  });

  const socket = sockets[0];
  if (socket === undefined) throw new Error('outbound client did not open a socket');
  return { client, control, sockets, socket, statuses, helloCount: () => hellos };
}

/** 让已解决的 promise 链跑完（snapshot 等一次 macrotask）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createHubNodeOutboundClient', () => {
  it('dials node-control and sends the node auth frame first', () => {
    const { socket, client } = harness();
    expect(socket.url).toBe('ws://127.0.0.1:8643/v1/hub/node-control');

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const frame = socket.lastFrame();
    expect(frame).toMatchObject({
      v: 1,
      kind: 'auth',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      token: 'node-token',
      hub_id: HUB_ID,
      node_id: NODE_ID,
      tenant_id: TENANT_ID,
    });
    expect(frame.incarnation).toMatch(/^[0-9a-f]{12}$/);
    client.close();
  });

  it('sends the initial snapshot after hello and bumps revision monotonically', async () => {
    const { socket, control, client, statuses, helloCount } = harness();
    socket.open();
    const incarnation = socket.lastFrame().incarnation;
    socket.message(helloFrame());
    await flush();

    expect(helloCount()).toBe(1);
    expect(statuses).toEqual([{ status: 'healthy' }]);
    expect(control.subscribeCalls).toBe(1);

    const initial = socket.lastFrame();
    expect(initial).toMatchObject({
      v: 1,
      kind: 'snapshot',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      node_id: NODE_ID,
      hub_id: HUB_ID,
      incarnation,
      revision: 1,
      observed_at: NOW,
      truncated: false,
      counts: { teams: 1, agents: 0, live_agents: 0 },
    });

    control.teams = [{ team_id: 'team-2', name: 'Team Two', member_count: 2, agent_count: 2 }];
    control.listener?.({ directoryChanged: true });
    await wait(300);

    const next = socket.lastFrame();
    expect(next.kind).toBe('snapshot');
    expect(next.revision).toBe(2);
    expect((next.teams as Array<{ team_id: string }>)[0]?.team_id).toBe('team-2');

    // 250ms debounce 合并连续变更：只多一次 snapshot。
    control.listener?.({ directoryChanged: true });
    control.listener?.({ directoryChanged: true });
    await wait(300);
    expect(control.snapshotCalls).toBe(3);
    expect(socket.lastFrame().revision).toBe(3);
    client.close();
  });

  it('rejects hello identity mismatch and stops reconnecting', async () => {
    const { socket, control, client, statuses, sockets } = harness();
    socket.open();
    socket.message(helloFrame({ node_id: 'node-2' }));
    await flush();

    expect(statuses.at(-1)).toEqual({ status: 'incompatible', error: 'identity_mismatch' });
    expect(client.status()).toBe('incompatible');
    expect(socket.closed).toBe(true);
    expect(control.snapshotCalls).toBe(0);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it('forwards pointers without waiting for a directory debounce', async () => {
    const { socket, control, client } = harness();
    socket.open();
    socket.message(helloFrame());
    await flush();

    control.listener?.({
      pointers: [{ team_id: 'team-1', request_id: 'req-1', reason: 'team.message', ts: 777 }],
    });

    expect(socket.lastFrame()).toEqual({
      v: 1,
      kind: 'pointer',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      node_id: NODE_ID,
      hub_id: HUB_ID,
      team_id: 'team-1',
      request_id: 'req-1',
      reason: 'team.message',
      ts: 777,
    });
    client.close();
  });

  it('replies to ping with a node pong', () => {
    const { socket, client } = harness();
    socket.open();
    socket.message(pingFrame());
    expect(socket.lastFrame()).toEqual({
      v: 1,
      kind: 'pong',
      protocol: 'vessel.hub/1',
      dialer: 'node',
    });
    client.close();
  });

  it('halts on 4401 as unauthorized', () => {
    const { socket, client, statuses, sockets } = harness();
    socket.open();
    socket.serverClose(4401);

    expect(statuses.at(-1)).toEqual({ status: 'unauthorized', error: 'unauthorized' });
    expect(client.status()).toBe('unauthorized');
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it('halts on 4400 as incompatible', () => {
    const { socket, client, statuses, sockets } = harness();
    socket.open();
    socket.serverClose(4400);

    expect(statuses.at(-1)).toEqual({ status: 'incompatible', error: 'incompatible' });
    expect(client.status()).toBe('incompatible');
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it('ignores a stale close from a replaced connection', async () => {
    const { sockets, client, control } = harness({
      reconnect: { initialMs: 5, maxMs: 5 },
    });
    const first = sockets[0];
    if (first === undefined) throw new Error('missing first socket');
    first.open();
    first.message(helloFrame());
    await flush();
    expect(client.status()).toBe('healthy');

    first.serverClose(1006);
    expect(client.status()).toBe('unreachable');

    await wait(40);
    const second = sockets[1];
    if (second === undefined) throw new Error('client did not reconnect');
    second.open();
    second.message(helloFrame());
    await flush();
    expect(client.status()).toBe('healthy');
    expect(second.lastFrame().revision).toBe(2);

    // 旧连接的迟到 close 不得把新连接的 healthy 覆盖成 unauthorized。
    first.emit('close', { code: 4401 });
    expect(client.status()).toBe('healthy');
    expect(sockets).toHaveLength(2);
    expect(control.snapshotCalls).toBe(2);
    client.close();
  });

  it('close is idempotent and unsubscribes', async () => {
    const { socket, control, client } = harness();
    socket.open();
    socket.message(helloFrame());
    await flush();

    client.close();
    expect(control.unsubscribed).toBe(1);
    expect(socket.closed).toBe(true);
    expect(() => client.close()).not.toThrow();
    expect(control.unsubscribed).toBe(1);
  });
});
