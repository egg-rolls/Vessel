import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_PROTOCOL } from '@vessel-agent/serve';
import { createHubJoinStore } from './join-store.js';
import { createHubNodeCredentialStore } from './node-credential-store.js';
import { createHubRegistry } from './registry.js';
import { createHubServer, type HubServer } from './server.js';
import type { HubNodeInboundDeps, HubNodeRecord } from './types.js';

const dirs: string[] = [];
const servers: HubServer[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-join-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function errorCode(body: Record<string, unknown>): unknown {
  const error = body.error;
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>).code
    : undefined;
}

function tokenOf(body: Record<string, unknown>): unknown {
  return body.token;
}

interface Harness {
  records: HubNodeRecord[];
  url: string;
  /** 等价于 `vessel hub join-code`：直接用真 join store 生成一枚。 */
  issue(): Promise<{ code: string }>;
  join(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

/**
 * 真装配：真 registry / join store / credential store + 真 HTTP。
 * 唯一假的是「派生来源集」——它由 `derive-origins.test.ts` 单独覆盖，
 * 这里只验证「join 会把它下发下去」。
 */
async function startHarness(
  derived: string[] | null = ['http://127.0.0.1:8642'],
): Promise<Harness> {
  const dataDir = await makeDir();
  const hubId = 'hub-test-1';
  const now = (): number => 1_700_000_000_000;
  const registry = createHubRegistry({ dataDir, hubId, now, debounceMs: 0 });
  await registry.load();
  const records: HubNodeRecord[] = [];
  const hooks: HubNodeInboundDeps['hooks'] = {
    onSnapshot: () => {},
    onPointer: () => {},
    onStatus: () => {},
    onJoined: (input) => {
      records.push({
        node_id: input.node_id,
        direction: 'node',
        status: 'connecting',
        truncated: false,
        counts: { teams: 0, agents: 0, live_agents: 0 },
        teams: [],
        agents: [],
        ...(input.entries !== undefined ? { entries: input.entries } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
      });
    },
  };
  const joinStore = createHubJoinStore({ dataDir, hubId, now });
  const nodeControl: HubNodeInboundDeps = {
    hubId,
    joinStore,
    credentials: await createHubNodeCredentialStore({ dataDir, now }),
    hooks,
    now,
    ...(derived !== null ? { derivedOrigins: () => derived } : {}),
  };
  const server = createHubServer({
    config: { listen: { hostname: '127.0.0.1', port: 0 } },
    hubId,
    registry,
    nodeControl,
    now,
  });
  servers.push(server);

  return {
    records,
    url: server.url,
    issue: () => joinStore.issue({}),
    join: async (body) => {
      const response = await fetch(`${server.url}/v1/hub/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

describe('POST /v1/hub/join（0.61 注册字段）', () => {
  test('带 code + entries：落目录并下发 derived origins', async () => {
    const harness = await startHarness();
    const { code } = await harness.issue();

    const result = await harness.join({
      protocol: HUB_PROTOCOL,
      code,
      node_id: 'node-1',
      version: '0.61.0',
      capabilities: ['gateway.rpc', 'web.ui'],
      entries: [
        { kind: 'loopback', url: 'http://127.0.0.1:8651' },
        { kind: 'private', url: 'http://192.168.1.5:8651' },
        { kind: 'public', url: 'https://node.example.com' },
      ],
    });

    expect(result.status).toBe(200);
    expect(typeof tokenOf(result.body)).toBe('string');
    expect(result.body.trusted_origins).toEqual(['http://127.0.0.1:8642']);
    expect(harness.records[0]?.entries).toEqual([
      { kind: 'loopback', url: 'http://127.0.0.1:8651' },
      { kind: 'private', url: 'http://192.168.1.5:8651' },
      { kind: 'public', url: 'https://node.example.com' },
    ]);
    expect(harness.records[0]?.capabilities).toEqual(['gateway.rpc', 'web.ui']);
    expect(harness.records[0]?.version).toBe('0.61.0');
  });

  test('声明 kind 与地址事实不符 → 400，且不消耗 code', async () => {
    const harness = await startHarness();
    const { code } = await harness.issue();

    const bad = await harness.join({
      protocol: HUB_PROTOCOL,
      code,
      node_id: 'node-1',
      entries: [{ kind: 'loopback', url: 'https://node.example.com' }],
    });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.body)).toBe('entry_kind_mismatch');

    const good = await harness.join({
      protocol: HUB_PROTOCOL,
      code,
      node_id: 'node-2',
      entries: [{ kind: 'loopback', url: 'http://127.0.0.1:8651' }],
    });
    expect(good.status).toBe(200);
  });

  test('同一枚 code 不能重放', async () => {
    const harness = await startHarness();
    const { code } = await harness.issue();
    const first = await harness.join({ protocol: HUB_PROTOCOL, code, node_id: 'node-1' });
    expect(first.status).toBe(200);
    const replay = await harness.join({ protocol: HUB_PROTOCOL, code, node_id: 'node-2' });
    expect(replay.status).toBe(410);
    expect(errorCode(replay.body)).toBe('pairing_used');
  });

  test('无 code + 回环 peer + 已有有效 token → 允许重注册并轮转 token', async () => {
    const harness = await startHarness();
    const { code } = await harness.issue();
    const first = await harness.join({ protocol: HUB_PROTOCOL, code, node_id: 'node-1' });
    expect(first.status).toBe(200);

    const again = await harness.join({
      protocol: HUB_PROTOCOL,
      node_id: 'node-1',
      entries: [{ kind: 'loopback', url: 'http://127.0.0.1:8651' }],
    });
    expect(again.status).toBe(200);
    expect(tokenOf(again.body)).not.toBe(tokenOf(first.body));
  });

  test('无 code + 无有效 token → 400 code_required', async () => {
    const harness = await startHarness();
    const result = await harness.join({ protocol: HUB_PROTOCOL, node_id: 'node-1' });
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe('code_required');
  });

  test('未知注册字段被丢弃而不是报错（协议演进）', async () => {
    const harness = await startHarness();
    const { code } = await harness.issue();
    const result = await harness.join({
      protocol: HUB_PROTOCOL,
      code,
      node_id: 'node-1',
      future_field: { hello: true },
      entries: [{ kind: 'loopback', url: 'http://127.0.0.1:8651', extra: 1 }],
    });
    expect(result.status).toBe(200);
  });

  test('未注入 derivedOrigins 时响应不带该字段（旧行为）', async () => {
    const harness = await startHarness(null);
    const { code } = await harness.issue();
    const result = await harness.join({ protocol: HUB_PROTOCOL, code, node_id: 'node-1' });
    expect(result.status).toBe(200);
    expect(result.body.trusted_origins).toBeUndefined();
  });
});
