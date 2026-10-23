/**
 * S5.1 hub server 路由：`POST /v1/hub/join`、失败限流、方向冲突与
 * 未配置时的 404；同时确认 `/v1/hub/directory` 行为不变。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubConfig } from '@vessel-agent/config';
import { createHubRegistry, type HubRegistry } from '../hub/registry';
import { createMemorySecretStore } from '../hub/secret-store';
import { createHubServer, type HubServer } from '../hub/server';
import type {
  HubJoinStoreLike,
  HubNodeCredentialStoreLike,
  HubNodeInboundDeps,
  HubNodeInboundHooks,
  HubNodeJoinedInput,
  HubNodeRecord,
  HubNodeSnapshot,
  HubNodeTokenRecord,
  IssuedHubNodeToken,
} from '../hub/types';

const HUB_ID = 'hub-test-1';
const NODE_ID = 'node-1';
const TENANT_ID = 'tenant-1';
const PAIRING_ID = `${NODE_ID}:${TENANT_ID}`;

class FakeJoinStore implements HubJoinStoreLike {
  readonly codes = new Map<string, { tenant_id: string }>();
  readonly used = new Set<string>();

  async issue(input: { tenant_id: string }): Promise<{ code: string; expires_at: number }> {
    const code = `CODE-${this.codes.size + 1}`;
    this.codes.set(code, { tenant_id: input.tenant_id });
    return { code, expires_at: 0 };
  }

  async consume(input: {
    code: string;
    hub_id: string;
    node_id: string;
    tenant_id: string;
  }): Promise<{ hub_id: string; tenant_id: string; node_id: string; pairing_id: string }> {
    const entry = this.codes.get(input.code);
    if (entry === undefined)
      throw Object.assign(new Error('missing'), { code: 'pairing_not_found' });
    if (this.used.has(input.code)) throw Object.assign(new Error('used'), { code: 'pairing_used' });
    if (input.hub_id !== HUB_ID) {
      throw Object.assign(new Error('invalid'), { code: 'pairing_invalid' });
    }
    if (entry.tenant_id !== input.tenant_id) {
      throw Object.assign(new Error('tenant'), { code: 'tenant_mismatch' });
    }
    this.used.add(input.code);
    return {
      hub_id: input.hub_id,
      tenant_id: input.tenant_id,
      node_id: input.node_id,
      pairing_id: `${input.node_id}:${input.tenant_id}`,
    };
  }
}

class FakeCredentials implements HubNodeCredentialStoreLike {
  private seq = 0;
  readonly records = new Map<string, HubNodeTokenRecord>();

  async issue(input: {
    hub_id: string;
    node_id: string;
    tenant_id: string;
    pairing_id: string;
  }): Promise<IssuedHubNodeToken> {
    this.seq += 1;
    const token = `node-token-${this.seq}`;
    const record: HubNodeTokenRecord = {
      token_id: `token-id-${this.seq}`,
      token_hash: 'hash',
      scope: 'node',
      hub_id: input.hub_id,
      node_id: input.node_id,
      tenant_id: input.tenant_id,
      pairing_id: input.pairing_id,
      issued_by: 'join',
      created_at: 0,
      expires_at: 1_000_000,
    };
    this.records.set(token, record);
    return {
      token,
      token_id: record.token_id,
      expires_at: record.expires_at,
      scope: 'node',
      hub_id: record.hub_id,
      node_id: record.node_id,
      tenant_id: record.tenant_id,
      pairing_id: record.pairing_id,
    };
  }

  authenticate(token: string): HubNodeTokenRecord | null {
    return this.records.get(token) ?? null;
  }

  async revoke(): Promise<{ token_id: string; revoked_at: number; changed: boolean } | null> {
    return null;
  }

  async revokePairing(): Promise<number> {
    return 0;
  }

  list(): HubNodeTokenRecord[] {
    return [...this.records.values()];
  }

  onRevoke(): () => void {
    return () => undefined;
  }
}

interface Harness {
  server: HubServer;
  registry: HubRegistry;
  joinStore: FakeJoinStore;
  credentials: FakeCredentials;
  joined: HubNodeJoinedInput[];
  dir: string;
}

const harnesses: Harness[] = [];

function makeRecord(overrides: Partial<HubNodeRecord> = {}): HubNodeRecord {
  return {
    pairing_id: PAIRING_ID,
    node_id: NODE_ID,
    tenant_id: TENANT_ID,
    url: 'http://127.0.0.1:8642',
    status: 'connecting',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

async function startHarness(
  options: { nodeControl?: boolean; seed?: HubNodeRecord } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-server-inbound-'));
  const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID, debounceMs: 0 });
  await registry.load();
  if (options.seed !== undefined) registry.upsert(options.seed);

  const joinStore = new FakeJoinStore();
  const credentials = new FakeCredentials();
  const joined: HubNodeJoinedInput[] = [];
  const hooks: HubNodeInboundHooks = {
    onSnapshot(_pairingId: string, _snapshot: HubNodeSnapshot) {},
    onPointer() {},
    onStatus() {},
    onJoined(input) {
      joined.push(input);
    },
  };
  const nodeControl: HubNodeInboundDeps = { hubId: HUB_ID, joinStore, credentials, hooks };
  const config: HubConfig = { listen: { hostname: '127.0.0.1', port: 0 } };

  const server = createHubServer({
    config,
    hubId: HUB_ID,
    registry,
    secretStore: createMemorySecretStore(),
    ...(options.nodeControl === false ? {} : { nodeControl }),
  });

  const harness: Harness = { server, registry, joinStore, credentials, joined, dir };
  harnesses.push(harness);
  return harness;
}

async function postJoin(server: HubServer, body: unknown): Promise<Response> {
  return fetch(`${server.url}/v1/hub/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function joinBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'vessel.hub/1',
    code: 'CODE-1',
    node_id: NODE_ID,
    tenant_id: TENANT_ID,
    ...overrides,
  };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.server.stop();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

describe('POST /v1/hub/join', () => {
  it('issues a node token and calls onJoined', async () => {
    const harness = await startHarness();
    harness.joinStore.codes.set('CODE-1', { tenant_id: TENANT_ID });

    const response = await postJoin(
      harness.server,
      joinBody({ alias: 'home-node', public_url: 'https://node.example.com' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      hub_id: HUB_ID,
      node_id: NODE_ID,
      tenant_id: TENANT_ID,
      pairing_id: PAIRING_ID,
      scope: 'node',
    });
    expect(typeof body.token).toBe('string');
    expect(typeof body.token_id).toBe('string');
    expect(typeof body.expires_at).toBe('number');

    expect(harness.joined).toHaveLength(1);
    expect(harness.joined[0]).toMatchObject({
      pairing_id: PAIRING_ID,
      node_id: NODE_ID,
      tenant_id: TENANT_ID,
      node_token_id: body.token_id,
      alias: 'home-node',
      public_url: 'https://node.example.com',
    });
    expect(harness.credentials.records.get(body.token as string)?.pairing_id).toBe(PAIRING_ID);
  });

  it('rejects the same code a second time with 410', async () => {
    const harness = await startHarness();
    harness.joinStore.codes.set('CODE-1', { tenant_id: TENANT_ID });

    expect((await postJoin(harness.server, joinBody())).status).toBe(200);
    const second = await postJoin(harness.server, joinBody());
    expect(second.status).toBe(410);
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('pairing_used');
  });

  it('rejects a pairing that already exists in the hub direction with 409', async () => {
    const harness = await startHarness({ seed: makeRecord() });
    harness.joinStore.codes.set('CODE-1', { tenant_id: TENANT_ID });

    const response = await postJoin(harness.server, joinBody());

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('pairing_exists_other_direction');
    expect(harness.joined).toHaveLength(0);
  });

  it('returns 426 for a protocol mismatch and 400 for missing fields', async () => {
    const harness = await startHarness();

    const wrongProtocol = await postJoin(harness.server, joinBody({ protocol: 'vessel.hub/2' }));
    expect(wrongProtocol.status).toBe(426);

    const missing = await postJoin(harness.server, { protocol: 'vessel.hub/1' });
    expect(missing.status).toBe(400);
  });

  it('rate limits repeated join failures per IP', async () => {
    const harness = await startHarness();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postJoin(harness.server, joinBody({ code: 'UNKNOWN' }));
      expect(response.status).toBe(404);
    }

    const limited = await postJoin(harness.server, joinBody({ code: 'UNKNOWN' }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns 404 for join when nodeControl is not configured', async () => {
    const harness = await startHarness({ nodeControl: false });

    const joinResponse = await postJoin(harness.server, joinBody());
    expect(joinResponse.status).toBe(404);

    const controlResponse = await fetch(`${harness.server.url}/v1/hub/node-control`);
    expect(controlResponse.status).toBe(404);
  });

  it('keeps the directory endpoint unchanged', async () => {
    const harness = await startHarness();

    const response = await fetch(`${harness.server.url}/v1/hub/directory`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { v?: number; hub_id?: string; nodes?: unknown[] };
    expect(body.v).toBe(1);
    expect(body.hub_id).toBe(HUB_ID);
    expect(body.nodes).toEqual([]);
  });
});
