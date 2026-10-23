import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_MAX_AGENTS, HUB_MAX_TEAMS } from '@vessel-agent/serve';
import { createHubRegistry, HUB_REGISTRY_FILE, type HubRegistryEvent } from '../hub/registry';
import type { HubNodeRecord } from '../hub/types';

const dirs: string[] = [];
const HUB_ID = 'hub-test-1';

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-registry-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function makeRecord(overrides: Partial<HubNodeRecord> = {}): HubNodeRecord {
  return {
    pairing_id: 'node-1:tenant-1',
    node_id: 'node-1',
    tenant_id: 'tenant-1',
    direction: 'hub',
    url: 'http://127.0.0.1:8642',
    data_plane: 'direct',
    status: 'connecting',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

function registryFile(dir: string): string {
  return join(dir, HUB_REGISTRY_FILE);
}

async function expectCorrupt(dir: string, content: string): Promise<void> {
  await writeFile(registryFile(dir), content);
  const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
  let error: unknown;
  try {
    await registry.load();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: 'hub_registry_corrupt' });
}

describe('createHubRegistry', () => {
  it('round-trips records through registry.json', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID, now: () => 1000 });
    await registry.load();

    const record = makeRecord({
      status: 'healthy',
      last_seen: 900,
      incarnation: 'inc-1',
      revision: 7,
      counts: { teams: 1, agents: 2, live_agents: 1 },
      teams: [{ team_id: 'team-1', name: 'Team One', member_count: 2, agent_count: 2 }],
      agents: [
        {
          agent_id: 'agent-1',
          name: 'A',
          team_id: 'team-1',
          membership: 'present',
          presence: 'live',
        },
      ],
    });
    registry.upsert(record);
    await registry.flush();

    const raw = JSON.parse(await readFile(registryFile(dir), 'utf8')) as {
      v: number;
      hub_id: string;
      updated_at: number;
      nodes: HubNodeRecord[];
    };
    expect(raw.v).toBe(1);
    expect(raw.hub_id).toBe(HUB_ID);
    expect(raw.updated_at).toBe(1000);
    expect(raw.nodes).toHaveLength(1);

    const reloaded = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await reloaded.load();
    expect(reloaded.get(record.pairing_id)).toEqual(record);
  });

  it('round-trips node-dial fields (direction / public_url / data_plane / node_token_id)', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID, now: () => 2000 });
    await registry.load();

    const record: HubNodeRecord = {
      pairing_id: 'node-2:tenant-1',
      node_id: 'node-2',
      tenant_id: 'tenant-1',
      direction: 'node',
      public_url: 'https://edge.example:8642',
      node_token_id: 'token-1',
      status: 'healthy',
      truncated: false,
      counts: { teams: 0, agents: 0, live_agents: 0 },
      teams: [],
      agents: [],
    };
    const expected: HubNodeRecord = { ...record, data_plane: 'direct' };
    expect(registry.upsert(record)).toEqual(expected);
    await registry.flush();

    const reloaded = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await reloaded.load();
    expect(reloaded.get(record.pairing_id)).toEqual(expected);
  });

  it('reads legacy records without direction as hub and writes direction back', async () => {
    const dir = await tempDataDir();
    const legacy = {
      pairing_id: 'node-1:tenant-1',
      node_id: 'node-1',
      tenant_id: 'tenant-1',
      url: 'http://127.0.0.1:8642',
      status: 'healthy',
      truncated: false,
      counts: { teams: 0, agents: 0, live_agents: 0 },
      teams: [],
      agents: [],
    };
    await writeFile(
      registryFile(dir),
      JSON.stringify({ v: 1, hub_id: HUB_ID, updated_at: 5, nodes: [legacy] }),
    );

    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await registry.load();
    const record = registry.get(legacy.pairing_id);
    expect(record?.direction).toBe('hub');
    expect(record?.data_plane).toBe('direct');
    expect(record?.url).toBe(legacy.url);
    expect(record?.public_url).toBeUndefined();

    await registry.flush();
    const raw = JSON.parse(await readFile(registryFile(dir), 'utf8')) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(raw.nodes[0]?.direction).toBe('hub');
    expect(raw.nodes[0]?.data_plane).toBe('direct');
  });

  it('accepts node-dial records without url but still requires url for hub records', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await registry.load();

    const stored = registry.upsert(
      makeRecord({
        pairing_id: 'node-2:tenant-1',
        node_id: 'node-2',
        direction: 'node',
        url: undefined,
        data_plane: undefined,
      }),
    );
    expect(stored.url).toBeUndefined();
    expect(stored.public_url).toBeUndefined();
    expect(stored.data_plane).toBe('unreachable');

    const noUrl = { ...makeRecord({ direction: 'hub' }) } as Record<string, unknown>;
    delete noUrl.url;
    expect(() => registry.upsert(noUrl as unknown as HubNodeRecord)).toThrow(
      'hub_registry_invalid_record',
    );
  });

  it('derives data_plane from public_url ?? url and re-derives on patch', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await registry.load();

    registry.upsert(makeRecord({ direction: 'node', url: undefined, data_plane: undefined }));
    expect(registry.get('node-1:tenant-1')?.data_plane).toBe('unreachable');

    registry.patch('node-1:tenant-1', { public_url: 'https://edge.example' });
    expect(registry.get('node-1:tenant-1')?.data_plane).toBe('direct');

    registry.patch('node-1:tenant-1', { url: 'http://127.0.0.1:9999' });
    expect(registry.get('node-1:tenant-1')?.data_plane).toBe('direct');

    // 显式 data_plane 优先于 url 派生。
    registry.patch('node-1:tenant-1', {
      url: 'http://127.0.0.1:9998',
      data_plane: 'unreachable',
    });
    expect(registry.get('node-1:tenant-1')?.data_plane).toBe('unreachable');
  });

  it('fails closed on an unknown direction or a hub record without url', async () => {
    const dirA = await tempDataDir();
    await expectCorrupt(
      dirA,
      JSON.stringify({
        v: 1,
        hub_id: HUB_ID,
        updated_at: 1,
        nodes: [{ ...makeRecord(), direction: 'sideways' }],
      }),
    );

    const dirB = await tempDataDir();
    const noUrl = { ...makeRecord() } as Record<string, unknown>;
    delete noUrl.url;
    await expectCorrupt(
      dirB,
      JSON.stringify({ v: 1, hub_id: HUB_ID, updated_at: 1, nodes: [noUrl] }),
    );
  });

  it('keeps multiple tenants on the same node as separate pairings', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID, debounceMs: 1 });
    await registry.load();

    const a = makeRecord({ pairing_id: 'node-1:tenant-a', tenant_id: 'tenant-a' });
    const b = makeRecord({ pairing_id: 'node-1:tenant-b', tenant_id: 'tenant-b' });
    registry.upsert(a);
    registry.upsert(b);
    registry.patch(a.pairing_id, { status: 'healthy' });
    await registry.flush();

    const reloaded = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.get(a.pairing_id)?.status).toBe('healthy');
    expect(reloaded.get(b.pairing_id)?.status).toBe('connecting');
  });

  it('fails closed on invalid JSON / version / fields', async () => {
    const dirA = await tempDataDir();
    await expectCorrupt(dirA, '{"v": 1,');

    const dirB = await tempDataDir();
    await expectCorrupt(dirB, JSON.stringify({ v: 2, hub_id: HUB_ID, updated_at: 1, nodes: [] }));

    const dirC = await tempDataDir();
    await expectCorrupt(
      dirC,
      JSON.stringify({
        v: 1,
        hub_id: HUB_ID,
        updated_at: 1,
        nodes: [{ pairing_id: 'node-1:tenant-1', node_id: 'node-1' }],
      }),
    );

    const dirD = await tempDataDir();
    await expectCorrupt(
      dirD,
      JSON.stringify({ v: 1, hub_id: 'other-hub', updated_at: 1, nodes: [] }),
    );
  });

  it('truncates teams and agents at the hard limits but keeps reported counts', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await registry.load();

    const teams = Array.from({ length: HUB_MAX_TEAMS + 5 }, (_, index) => ({
      team_id: `team-${index}`,
      name: `Team ${index}`,
      member_count: 0,
      agent_count: 0,
    }));
    const agents = Array.from({ length: HUB_MAX_AGENTS + 5 }, (_, index) => ({
      agent_id: `agent-${index}`,
      team_id: 'team-0',
      membership: 'present' as const,
      presence: 'live' as const,
    }));

    registry.upsert(
      makeRecord({
        teams,
        agents,
        counts: {
          teams: HUB_MAX_TEAMS + 5,
          agents: HUB_MAX_AGENTS + 5,
          live_agents: 3,
        },
      }),
    );

    const stored = registry.get('node-1:tenant-1');
    expect(stored?.teams).toHaveLength(HUB_MAX_TEAMS);
    expect(stored?.agents).toHaveLength(HUB_MAX_AGENTS);
    expect(stored?.truncated).toBe(true);
    expect(stored?.counts).toEqual({
      teams: HUB_MAX_TEAMS + 5,
      agents: HUB_MAX_AGENTS + 5,
      live_agents: 3,
    });

    // patch 同样受上限约束。
    registry.patch('node-1:tenant-1', {
      truncated: false,
      teams,
      agents,
    });
    const patched = registry.get('node-1:tenant-1');
    expect(patched?.teams).toHaveLength(HUB_MAX_TEAMS);
    expect(patched?.agents).toHaveLength(HUB_MAX_AGENTS);
    expect(patched?.truncated).toBe(true);
  });

  it('never persists forbidden content fields', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID });
    await registry.load();

    const polluted = {
      ...makeRecord(),
      content: 'secret body',
      messages: [{ role: 'user', content: 'secret body' }],
      transcript: 'secret body',
      event: { type: 'run.event' },
      session_id: 'session-1',
      workspace: '/tmp/workspace',
      system_prompt: 'secret prompt',
      model: 'model-1',
      input: 'secret input',
      output: 'secret output',
      token: 'secret-token',
      token_hash: 'hash',
      handoff_path: '/tmp/handoff',
      policy: 'allow',
      body_history: [{ session_id: 'session-1', content: 'secret body' }],
      reply: { content: 'secret body' },
    } as unknown as HubNodeRecord;

    registry.upsert(polluted);
    await registry.flush();

    const text = await readFile(registryFile(dir), 'utf8');
    for (const key of [
      'content',
      'messages',
      'transcript',
      'event',
      'session_id',
      'workspace',
      'system_prompt',
      'model',
      'input',
      'output',
      'token',
      'token_hash',
      'handoff_path',
      'policy',
      'body_history',
      'reply',
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it('emits upsert / patch / remove events and supports unsubscribe', async () => {
    const dir = await tempDataDir();
    const registry = createHubRegistry({ dataDir: dir, hubId: HUB_ID, debounceMs: 1000 });
    await registry.load();

    const events: HubRegistryEvent[] = [];
    const unsubscribe = registry.subscribe((event) => events.push(event));

    registry.upsert(makeRecord());
    registry.patch('node-1:tenant-1', { status: 'healthy' });
    registry.remove('node-1:tenant-1');
    unsubscribe();
    registry.upsert(makeRecord());

    expect(events).toEqual([
      { type: 'upsert', pairing_id: 'node-1:tenant-1' },
      { type: 'patch', pairing_id: 'node-1:tenant-1' },
      { type: 'remove', pairing_id: 'node-1:tenant-1' },
    ]);
    await registry.flush();
  });
});
