/**
 * S5 `/v1/hub/control`：鉴权、hub_id 绑定、snapshot / pointer 白名单、
 * 协议校验，以及“hub 连接不进入 events 广播”。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type {
  HubAgentMeta,
  HubControlChange,
  HubControlLike,
  HubNodeSnapshotInput,
  HubTeamMeta,
} from '../src/hub-control';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway, TestWs, waitUntil } from './helpers';

const gateways: Gateway[] = [];
const hubClients: HubWsClient[] = [];
const eventClients: TestWs[] = [];

afterEach(() => {
  for (const client of hubClients.splice(0)) client.close();
  for (const client of eventClients.splice(0)) client.close();
  for (const gateway of gateways.splice(0)) {
    void gateway.stop();
  }
});

function authWithHubTokens(): GatewayAuthLike {
  return {
    configured: true,
    authenticate(token) {
      switch (token) {
        case 'view-token':
          return { tenant_id: 'default', role: 'read', scope: 'view', hub_id: 'hub-1' };
        case 'admin-token':
          return { tenant_id: 'default', role: 'admin', scope: 'admin', hub_id: 'hub-1' };
        case 'control-token':
          return {
            tenant_id: 'default',
            role: 'write',
            scope: 'control',
            team_id: 'team-1',
            hub_id: 'hub-1',
          };
        case 'exchange-token':
          return { tenant_id: 'default', role: 'write', scope: 'exchange', hub_id: 'hub-1' };
        default:
          return null;
      }
    },
  };
}

interface HubControlHarness {
  control: HubControlLike;
  emit(change: HubControlChange): void;
  snapshotCount(): number;
  unsubscribeCount(): number;
  snapshotTenants: string[];
}

function makeHubControl(input: HubNodeSnapshotInput = baseSnapshot()): HubControlHarness {
  const listeners = new Set<(change: HubControlChange) => void>();
  const snapshotTenants: string[] = [];
  let snapshots = 0;
  let unsubscribed = 0;
  const control: HubControlLike = {
    async snapshot(tenantId) {
      snapshots += 1;
      snapshotTenants.push(tenantId);
      return input;
    },
    subscribe(tenantId, listener) {
      snapshotTenants.push(`subscribe:${tenantId}`);
      listeners.add(listener);
      return () => {
        unsubscribed += 1;
        listeners.delete(listener);
      };
    },
  };
  return {
    control,
    emit(change) {
      for (const listener of [...listeners]) listener(change);
    },
    snapshotCount: () => snapshots,
    unsubscribeCount: () => unsubscribed,
    snapshotTenants,
  };
}

function baseSnapshot(): HubNodeSnapshotInput {
  return {
    counts: { teams: 1, agents: 1, live_agents: 1 },
    teams: [{ team_id: 'team-1', name: 'Team One', member_count: 2, agent_count: 1 }],
    agents: [
      {
        agent_id: 'agent-1',
        name: 'Agent One',
        team_id: 'team-1',
        membership: 'present',
        presence: 'live',
      },
    ],
    truncated: false,
  };
}

function startTestGateway(hubControl?: HubControlLike, events = new MemoryEventStream()): Gateway {
  const gateway = createGateway({
    events,
    nodeId: 'node-1',
    auth: authWithHubTokens(),
    ...(hubControl !== undefined ? { hubControl } : {}),
  });
  gateways.push(gateway);
  return gateway;
}

type Frame = Record<string, unknown>;

function isFrame(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `/v1/hub/control` 的最小 WS 客户端。 */
class HubWsClient {
  private readonly frames: Frame[] = [];
  private readonly seen: Frame[] = [];
  private readonly waiters: Array<{
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closeCode: number | null = null;
  private readonly closeWaiters: Array<{
    resolve: (code: number) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let frame: Frame;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isFrame(parsed)) return;
        frame = parsed;
      } catch {
        return;
      }
      this.seen.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.match(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        if (waiter === undefined) return;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
    ws.addEventListener('close', (event) => {
      this.closeCode = event.code;
      for (const waiter of this.closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(event.code);
      }
    });
  }

  static async connect(gateway: Gateway): Promise<HubWsClient> {
    const url = `${gateway.url.replace(/^http/, 'ws')}/v1/hub/control`;
    const ws = new WebSocket(url);
    const client = new HubWsClient(ws);
    hubClients.push(client);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('hub control connect failed')), {
        once: true,
      });
    });
    return client;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  auth(token: string, overrides: Record<string, unknown> = {}): void {
    this.send({
      v: 1,
      kind: 'auth',
      protocol: 'vessel.hub/1',
      dialer: 'hub',
      token,
      hub_id: 'hub-1',
      ...overrides,
    });
  }

  next(match: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const index = this.frames.findIndex(match);
    if (index >= 0) {
      const [frame] = this.frames.splice(index, 1);
      if (frame !== undefined) return Promise.resolve(frame);
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error('timed out waiting for hub control frame'));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  /** 已收到的全部帧种类（含已被 next 消费的帧）。 */
  kinds(): unknown[] {
    return this.seen.map((frame) => frame.kind);
  }

  closed(timeoutMs = 3000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.closeWaiters.push({ resolve, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('hub control WS', () => {
  it('returns 404 when hubControl is not injected', async () => {
    const gateway = startTestGateway();
    const response = await fetch(`${gateway.url}/v1/hub/control`);
    expect(response.status).toBe(404);
  });

  it('rejects a first frame without hub_id or with a mismatched hub_id', async () => {
    const gateway = startTestGateway(makeHubControl().control);

    const missing = await HubWsClient.connect(gateway);
    missing.auth('view-token', { hub_id: '' });
    expect(await missing.closed()).toBe(4401);

    const mismatched = await HubWsClient.connect(gateway);
    mismatched.auth('view-token', { hub_id: 'hub-2' });
    expect(await mismatched.closed()).toBe(4401);
  });

  it('rejects control and exchange scopes with 4403', async () => {
    const gateway = startTestGateway(makeHubControl().control);

    const control = await HubWsClient.connect(gateway);
    control.auth('control-token');
    expect(await control.closed()).toBe(4403);

    const exchange = await HubWsClient.connect(gateway);
    exchange.auth('exchange-token');
    expect(await exchange.closed()).toBe(4403);
  });

  it('accepts a view token and sends hello followed by a snapshot', async () => {
    const harness = makeHubControl();
    const gateway = startTestGateway(harness.control);
    const client = await HubWsClient.connect(gateway);

    client.auth('view-token');
    const hello = await client.next((frame) => frame.kind === 'hello');
    expect(hello.protocol).toBe('vessel.hub/1');
    expect(hello.dialer).toBe('hub');
    expect(hello.node_id).toBe('node-1');
    expect(hello.hub_id).toBe('hub-1');
    expect(hello.tenant_id).toBe('default');
    expect(typeof hello.incarnation).toBe('string');
    expect(typeof hello.revision).toBe('number');

    const snapshot = await client.next((frame) => frame.kind === 'snapshot');
    expect(snapshot.node_id).toBe('node-1');
    expect(snapshot.hub_id).toBe('hub-1');
    expect(snapshot.revision).toBe((hello.revision as number) + 1);
    expect(snapshot.counts).toEqual({ teams: 1, agents: 1, live_agents: 1 });
    expect(snapshot.teams).toHaveLength(1);
    expect(snapshot.agents).toHaveLength(1);
    expect(harness.snapshotTenants).toContain('subscribe:default');
    expect(harness.snapshotTenants).toContain('default');

    // 断开后退订。
    client.close();
    await waitUntil(() => harness.unsubscribeCount() === 1);
  });

  it('only emits whitelisted snapshot and pointer fields', async () => {
    const noisyTeam = {
      team_id: 'team-1',
      name: 'Team One',
      member_count: 2,
      agent_count: 1,
      content: 'secret-content',
      session_id: 'secret-session',
      system_prompt: 'secret-prompt',
      event: { type: 'secret-event' },
    } as unknown as HubTeamMeta;
    const noisyAgent = {
      agent_id: 'agent-1',
      name: 'Agent One',
      team_id: 'team-1',
      membership: 'present',
      presence: 'live',
      content: 'secret-content',
      session_id: 'secret-session',
      system_prompt: 'secret-prompt',
      event: { type: 'secret-event' },
    } as unknown as HubAgentMeta;
    const harness = makeHubControl({
      counts: { teams: 1, agents: 1, live_agents: 1 },
      teams: [noisyTeam],
      agents: [noisyAgent],
      truncated: false,
    });
    const gateway = startTestGateway(harness.control);
    const client = await HubWsClient.connect(gateway);

    client.auth('view-token');
    await client.next((frame) => frame.kind === 'hello');
    const snapshot = await client.next((frame) => frame.kind === 'snapshot');
    const encoded = JSON.stringify(snapshot);
    for (const leak of ['secret-content', 'secret-session', 'secret-prompt', 'secret-event']) {
      expect(encoded.includes(leak)).toBe(false);
    }
    const team = (snapshot.teams as Frame[])[0];
    const agent = (snapshot.agents as Frame[])[0];
    if (team === undefined || agent === undefined) throw new Error('missing snapshot entries');
    expect(Object.keys(team).sort()).toEqual(
      ['agent_count', 'member_count', 'name', 'team_id'].sort(),
    );
    expect(Object.keys(agent).sort()).toEqual(
      ['agent_id', 'membership', 'name', 'presence', 'team_id'].sort(),
    );

    harness.emit({
      pointers: [{ team_id: 'team-1', request_id: 'req-1', reason: 'permission.request', ts: 111 }],
    });
    const pointer = await client.next((frame) => frame.kind === 'pointer');
    expect(pointer).toEqual({
      v: 1,
      kind: 'pointer',
      protocol: 'vessel.hub/1',
      dialer: 'hub',
      node_id: 'node-1',
      hub_id: 'hub-1',
      team_id: 'team-1',
      request_id: 'req-1',
      reason: 'permission.request',
      ts: 111,
    });
  });

  it('debounces directoryChanged into a new snapshot revision', async () => {
    const harness = makeHubControl();
    const gateway = startTestGateway(harness.control);
    const client = await HubWsClient.connect(gateway);

    client.auth('view-token');
    const hello = await client.next((frame) => frame.kind === 'hello');
    const first = await client.next((frame) => frame.kind === 'snapshot');
    expect(first.revision).toBe((hello.revision as number) + 1);

    harness.emit({ directoryChanged: true });
    harness.emit({ directoryChanged: true });
    const second = await client.next((frame) => frame.kind === 'snapshot');
    expect(second.revision).toBe((first.revision as number) + 1);
    expect(harness.snapshotCount()).toBe(2);
  });

  it('keeps snapshot revisions monotonic across reconnects', async () => {
    const gateway = startTestGateway(makeHubControl().control);

    const first = await HubWsClient.connect(gateway);
    first.auth('view-token');
    await first.next((frame) => frame.kind === 'hello');
    const firstSnapshot = await first.next((frame) => frame.kind === 'snapshot');
    first.close();
    await first.closed(2000).catch(() => undefined);

    const second = await HubWsClient.connect(gateway);
    second.auth('view-token');
    const secondHello = await second.next((frame) => frame.kind === 'hello');
    const secondSnapshot = await second.next((frame) => frame.kind === 'snapshot');

    expect(Number(secondHello.revision)).toBeGreaterThanOrEqual(Number(firstSnapshot.revision));
    expect(Number(secondSnapshot.revision)).toBeGreaterThan(Number(firstSnapshot.revision));
  });

  it('closes with 4400 on an unsupported protocol or dialer', async () => {
    const gateway = startTestGateway(makeHubControl().control);

    const protocol = await HubWsClient.connect(gateway);
    protocol.auth('view-token', { protocol: 'vessel.hub/2' });
    expect(await protocol.closed()).toBe(4400);

    const dialer = await HubWsClient.connect(gateway);
    dialer.auth('view-token', { dialer: 'bogus' });
    expect(await dialer.closed()).toBe(4400);

    const version = await HubWsClient.connect(gateway);
    version.auth('view-token', { v: 2 });
    expect(await version.closed()).toBe(4400);
  });

  it('never receives /v1/events broadcasts', async () => {
    const events = new MemoryEventStream();
    const gateway = startTestGateway(makeHubControl().control, events);

    const eventClient = await TestWs.connect(gateway);
    eventClients.push(eventClient);
    await eventClient.next((frame) => frame.kind === 'hello');

    const hubClient = await HubWsClient.connect(gateway);
    hubClient.auth('view-token');
    await hubClient.next((frame) => frame.kind === 'hello');
    await hubClient.next((frame) => frame.kind === 'snapshot');

    events.publish({ type: 'run.started', run_id: 'run-1', data: { n: 1 }, ts: Date.now() });
    const received = await eventClient.next(
      (frame) => frame.kind === 'event' && frame.event.type === 'run.started',
    );
    expect(received.kind).toBe('event');
    expect(hubClient.kinds()).not.toContain('event');
    await expect(hubClient.next((frame) => frame.kind === 'event', 100)).rejects.toThrow();
  });
});
