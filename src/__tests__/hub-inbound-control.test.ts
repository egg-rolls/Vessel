/**
 * S5.1 `/v1/hub/node-control` 状态机：auth 身份绑定、方向校验、快照新旧、
 * 单连接接管与心跳 / 停止清理。全部使用假 WS，不联网。
 */
import { describe, expect, it } from 'bun:test';
import { buildHubAuthFrame } from '@vessel-agent/serve';
import {
  createHubNodeInbound,
  type HubNodeInbound,
  type HubNodeInboundConnection,
  type HubNodeInboundWs,
} from '../hub/inbound-control';
import type {
  HubJoinStoreLike,
  HubNodeCredentialStoreLike,
  HubNodeInboundDeps,
  HubNodeInboundHooks,
  HubNodeJoinedInput,
  HubNodePointer,
  HubNodeSnapshot,
  HubNodeStatus,
  HubNodeTokenRecord,
} from '../hub/types';

const HUB_ID = 'hub-1';
const NODE_ID = 'node-1';
const TENANT_ID = 'tenant-1';
const PAIRING_ID = `${NODE_ID}:${TENANT_ID}`;
const TOKEN = 'node-token-good';
const TOKEN_ID = 'token-id-1';

const BASE_RECORD: HubNodeTokenRecord = {
  token_id: TOKEN_ID,
  token_hash: 'hash',
  scope: 'node',
  hub_id: HUB_ID,
  node_id: NODE_ID,
  tenant_id: TENANT_ID,
  pairing_id: PAIRING_ID,
  issued_by: 'join',
  created_at: 0,
  expires_at: 1_000_000,
};

class FakeWs implements HubNodeInboundWs {
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = { code, reason };
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

interface Captured {
  snapshots: { pairingId: string; snapshot: HubNodeSnapshot }[];
  pointers: HubNodePointer[];
  statuses: { pairingId: string; status: HubNodeStatus; error?: string }[];
  joined: HubNodeJoinedInput[];
}

function makeHooks(): { hooks: HubNodeInboundHooks } & Captured {
  const captured: Captured = { snapshots: [], pointers: [], statuses: [], joined: [] };
  const hooks: HubNodeInboundHooks = {
    onSnapshot(pairingId, snapshot) {
      captured.snapshots.push({ pairingId, snapshot });
    },
    onPointer(pointer) {
      captured.pointers.push(pointer);
    },
    onStatus(pairingId, status, error) {
      captured.statuses.push({ pairingId, status, ...(error !== undefined ? { error } : {}) });
    },
    onJoined(input) {
      captured.joined.push(input);
    },
  };
  return { hooks, ...captured };
}

function makeCredentials(
  override: Partial<HubNodeTokenRecord> = {},
  token = TOKEN,
): HubNodeCredentialStoreLike {
  const record: HubNodeTokenRecord = { ...BASE_RECORD, ...override };
  return {
    async issue() {
      throw new Error('not used by inbound tests');
    },
    authenticate(value: string) {
      return value === token ? record : null;
    },
    async revoke() {
      return null;
    },
    async revokePairing() {
      return 0;
    },
    list() {
      return [record];
    },
    onRevoke() {
      return () => undefined;
    },
  };
}

const JOIN_STORE: HubJoinStoreLike = {
  async issue() {
    return { code: 'unused', expires_at: 0 };
  },
  async consume() {
    throw new Error('not used by inbound tests');
  },
};

interface Setup {
  inbound: HubNodeInbound;
  hooks: Captured;
}

function setup(
  overrides: Partial<HubNodeInboundDeps> = {},
  credentials: HubNodeCredentialStoreLike = makeCredentials(),
): Setup {
  const { hooks, ...captured } = makeHooks();
  const inbound = createHubNodeInbound({
    hubId: HUB_ID,
    joinStore: JOIN_STORE,
    credentials,
    hooks,
    authTimeoutMs: 1_000,
    pingIntervalMs: 10_000,
    idleTimeoutMs: 30_000,
    ...overrides,
  });
  return { inbound, hooks: captured };
}

function authFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...buildHubAuthFrame({
      dialer: 'node',
      token: TOKEN,
      hubId: HUB_ID,
      nodeId: NODE_ID,
      tenantId: TENANT_ID,
    }),
    ...overrides,
  };
}

function openAndAuth(
  inbound: HubNodeInbound,
  ws: FakeWs,
  frame: Record<string, unknown> = authFrame(),
): HubNodeInboundConnection {
  const conn = inbound.open(ws);
  inbound.message(conn, JSON.stringify(frame));
  return conn;
}

function snapshotFrame(
  incarnation: string,
  revision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    kind: 'snapshot',
    protocol: 'vessel.hub/1',
    dialer: 'node',
    node_id: NODE_ID,
    hub_id: HUB_ID,
    incarnation,
    revision,
    observed_at: 1_000,
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

function pointerFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'pointer',
    protocol: 'vessel.hub/1',
    dialer: 'node',
    node_id: NODE_ID,
    hub_id: HUB_ID,
    team_id: 'team-1',
    reason: 'team.message',
    ts: 1_000,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

describe('createHubNodeInbound', () => {
  it('authenticates the node token, sends hello, and reports healthy', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    openAndAuth(inbound, ws);

    expect(ws.closedWith).toBeUndefined();
    const hello = ws.frames().find((frame) => frame.kind === 'hello');
    expect(hello).toBeDefined();
    expect(hello).toMatchObject({
      kind: 'hello',
      protocol: 'vessel.hub/1',
      dialer: 'node',
      hub_id: HUB_ID,
      node_id: NODE_ID,
      tenant_id: TENANT_ID,
    });
    expect(hooks.statuses).toEqual([{ pairingId: PAIRING_ID, status: 'healthy' }]);
    inbound.stop();
  });

  it('rejects an unknown token with 4401', () => {
    const { inbound } = setup();
    const ws = new FakeWs();
    openAndAuth(inbound, ws, authFrame({ token: 'bad-token' }));

    expect(ws.closedWith?.code).toBe(4401);
    inbound.stop();
  });

  it('rejects hub_id, node_id and tenant_id mismatches with 4401', () => {
    for (const overrides of [
      { hub_id: 'hub-2' },
      { node_id: 'node-2' },
      { tenant_id: 'tenant-2' },
    ]) {
      const { inbound } = setup();
      const ws = new FakeWs();
      openAndAuth(inbound, ws, authFrame(overrides));
      expect(ws.closedWith?.code).toBe(4401);
      inbound.stop();
    }
  });

  it('rejects a token record whose pairing_id is inconsistent', () => {
    const credentials = makeCredentials({ pairing_id: 'node-1:other' });
    const { inbound } = setup({}, credentials);
    const ws = new FakeWs();
    openAndAuth(inbound, ws);

    expect(ws.closedWith?.code).toBe(4401);
    inbound.stop();
  });

  it('rejects the wrong dialer and protocol with 4400', () => {
    const wrongDialer = setup();
    const wsDialer = new FakeWs();
    openAndAuth(
      wrongDialer.inbound,
      wsDialer,
      authFrame({ dialer: 'hub', node_id: undefined, tenant_id: undefined }),
    );
    expect(wsDialer.closedWith?.code).toBe(4400);
    wrongDialer.inbound.stop();

    const wrongProtocol = setup();
    const wsProtocol = new FakeWs();
    openAndAuth(wrongProtocol.inbound, wsProtocol, authFrame({ protocol: 'vessel.hub/9' }));
    expect(wsProtocol.closedWith?.code).toBe(4400);
    wrongProtocol.inbound.stop();
  });

  it('accepts increasing snapshots and drops stale revisions', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    const conn = openAndAuth(inbound, ws);

    inbound.message(conn, JSON.stringify(snapshotFrame('inc-1', 2)));
    inbound.message(conn, JSON.stringify(snapshotFrame('inc-1', 2)));
    inbound.message(conn, JSON.stringify(snapshotFrame('inc-1', 1)));
    expect(hooks.snapshots).toHaveLength(1);
    expect(hooks.snapshots[0]?.snapshot).toMatchObject({ incarnation: 'inc-1', revision: 2 });

    // incarnation 变化 → 无条件接受下一个快照（revision 归零也接受）。
    inbound.message(conn, JSON.stringify(snapshotFrame('inc-2', 0)));
    expect(hooks.snapshots).toHaveLength(2);
    expect(hooks.snapshots[1]?.snapshot).toMatchObject({ incarnation: 'inc-2', revision: 0 });
    inbound.stop();
  });

  it('closes with identity_mismatch when a snapshot carries another node identity', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    const conn = openAndAuth(inbound, ws);

    inbound.message(conn, JSON.stringify(snapshotFrame('inc-1', 1, { node_id: 'node-9' })));

    expect(ws.closedWith?.code).toBe(4401);
    expect(hooks.snapshots).toHaveLength(0);
    expect(hooks.statuses).toContainEqual({
      pairingId: PAIRING_ID,
      status: 'identity_mismatch',
      error: 'identity mismatch',
    });
    inbound.stop();
  });

  it('forwards pointer frames without parsing content', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    const conn = openAndAuth(inbound, ws);

    inbound.message(conn, JSON.stringify(pointerFrame({ request_id: 'req-1' })));

    expect(hooks.pointers).toHaveLength(1);
    expect(hooks.pointers[0]).toMatchObject({
      node_id: NODE_ID,
      hub_id: HUB_ID,
      team_id: 'team-1',
      reason: 'team.message',
      request_id: 'req-1',
    });
    inbound.stop();
  });

  it('lets a newer connection take over and ignores the stale close', () => {
    const { inbound, hooks } = setup();
    const wsFirst = new FakeWs();
    const first = openAndAuth(inbound, wsFirst);
    const wsSecond = new FakeWs();
    const second = openAndAuth(inbound, wsSecond);

    expect(wsFirst.closedWith?.code).toBe(1001);
    // 旧连接的 close 不能把新连接标成 unreachable。
    inbound.close(first);
    expect(hooks.statuses.filter((entry) => entry.status === 'unreachable')).toHaveLength(0);

    inbound.close(second);
    expect(hooks.statuses.filter((entry) => entry.status === 'unreachable')).toHaveLength(1);
    expect(hooks.statuses.at(-1)).toMatchObject({
      pairingId: PAIRING_ID,
      status: 'unreachable',
      error: 'disconnected',
    });
    inbound.stop();
  });

  it('closeByTokenId closes the live connection without marking it unreachable', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    const conn = openAndAuth(inbound, ws);

    expect(inbound.closeByTokenId(TOKEN_ID)).toBe(1);
    expect(ws.closedWith?.code).toBe(4401);
    inbound.close(conn);
    expect(hooks.statuses.filter((entry) => entry.status === 'unreachable')).toHaveLength(0);
    inbound.stop();
  });

  it('pings and closes an idle connection with 1001 / unreachable', async () => {
    const { inbound, hooks } = setup({ pingIntervalMs: 20, idleTimeoutMs: 500 });
    const ws = new FakeWs();
    openAndAuth(inbound, ws);

    await waitUntil(() => ws.closedWith !== undefined);

    expect(ws.closedWith?.code).toBe(1001);
    expect(ws.frames().some((frame) => frame.kind === 'ping')).toBe(true);
    expect(hooks.statuses).toContainEqual({
      pairingId: PAIRING_ID,
      status: 'unreachable',
      error: 'disconnected',
    });
    inbound.stop();
  });

  it('closes the socket when auth does not arrive in time', async () => {
    const { inbound } = setup({ authTimeoutMs: 5 });
    const ws = new FakeWs();
    inbound.open(ws);

    await waitUntil(() => ws.closedWith !== undefined);
    expect(ws.closedWith?.code).toBe(4401);
    inbound.stop();
  });

  it('stop() closes connections, clears timers, and is idempotent', () => {
    const { inbound, hooks } = setup();
    const ws = new FakeWs();
    const conn = openAndAuth(inbound, ws);

    inbound.stop();
    inbound.stop();
    expect(ws.closedWith?.code).toBe(1001);

    // stop 之后再来的 close 不应再上报 unreachable。
    inbound.close(conn);
    expect(hooks.statuses.filter((entry) => entry.status === 'unreachable')).toHaveLength(0);
  });
});
