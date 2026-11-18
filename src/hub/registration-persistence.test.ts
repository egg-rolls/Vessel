import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUB_NODE_STATE_FILE,
  readHubNodeState,
  readHubNodeTrustedOrigins,
  writeHubNodeState,
} from './node-state.js';
import { createHubRegistry, HUB_REGISTRY_FILE } from './registry.js';
import type { HubNodeRecord } from './types.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-persist-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<HubNodeRecord> & { node_id: string }): HubNodeRecord {
  return {
    direction: 'node',
    status: 'connecting',
    truncated: false,
    counts: { teams: 0, agents: 0, live_agents: 0 },
    teams: [],
    agents: [],
    ...overrides,
  };
}

describe('hub-node.json 的 trusted_origins', () => {
  test('写入 → 读回（归一 + 去重 + 丢掉非法条目）', async () => {
    const dataDir = await makeDir();
    await writeHubNodeState(dataDir, {
      v: 1,
      hub_url: 'http://127.0.0.1:8643',
      hub_id: 'hub-1',
      node_id: 'node-1',
      token_id: 'token-1',
      expires_at: 2,
      joined_at: 1,
      trusted_origins: ['http://127.0.0.1:8642/', 'http://127.0.0.1:8642', 'not-an-origin'],
    });
    const state = await readHubNodeState(dataDir);
    expect(state?.trusted_origins).toEqual(['http://127.0.0.1:8642']);
    expect(await readHubNodeTrustedOrigins(dataDir)).toEqual(['http://127.0.0.1:8642']);
  });

  test('旧文件没有该字段 ⇒ undefined（与今天等价）', async () => {
    const dataDir = await makeDir();
    await writeHubNodeState(dataDir, {
      v: 1,
      hub_url: 'http://127.0.0.1:8643',
      hub_id: 'hub-1',
      node_id: 'node-1',
      token_id: 'token-1',
      expires_at: 2,
      joined_at: 1,
    });
    expect(await readHubNodeTrustedOrigins(dataDir)).toBeUndefined();
  });

  test('文件损坏 / 缺失时读来源集返回 undefined（不阻塞启动）', async () => {
    const dataDir = await makeDir();
    expect(await readHubNodeTrustedOrigins(dataDir)).toBeUndefined();
    await writeFile(join(dataDir, HUB_NODE_STATE_FILE), '{not json', 'utf8');
    expect(await readHubNodeTrustedOrigins(dataDir)).toBeUndefined();
  });
});

describe('registry.json 的注册字段', () => {
  test('entries / capabilities / version / registered_at 能落盘并读回', async () => {
    const dataDir = await makeDir();
    const hubId = 'hub-1';
    const registry = createHubRegistry({ dataDir, hubId, now: () => 1, debounceMs: 0 });
    await registry.load();
    registry.upsert(
      record({
        node_id: 'node-1',
        entries: [{ kind: 'loopback', url: 'http://127.0.0.1:8651' }],
        capabilities: ['gateway.rpc'],
        version: '0.61.0',
        registered_at: 42,
      }),
    );
    await registry.flush();

    const reopened = createHubRegistry({ dataDir, hubId, now: () => 1, debounceMs: 0 });
    await reopened.load();
    const loaded = reopened.get('node-1');
    expect(loaded?.entries).toEqual([{ kind: 'loopback', url: 'http://127.0.0.1:8651' }]);
    expect(loaded?.capabilities).toEqual(['gateway.rpc']);
    expect(loaded?.version).toBe('0.61.0');
    expect(loaded?.registered_at).toBe(42);
  });

  test('坏 entries 单独丢弃，记录本身仍可加载（不判 corrupt）', async () => {
    const dataDir = await makeDir();
    const hubId = 'hub-1';
    await writeFile(
      join(dataDir, HUB_REGISTRY_FILE),
      JSON.stringify({
        v: 1,
        hub_id: hubId,
        updated_at: 1,
        nodes: [
          {
            node_id: 'node-1',
            direction: 'node',
            status: 'connecting',
            truncated: false,
            counts: { teams: 0, agents: 0, live_agents: 0 },
            teams: [],
            agents: [],
            registered_at: 7,
            entries: [
              { kind: 'nonsense', url: 'http://127.0.0.1:1' },
              { kind: 'loopback', url: 'http://127.0.0.1:8651' },
            ],
          },
        ],
      }),
      'utf8',
    );
    const registry = createHubRegistry({ dataDir, hubId, now: () => 1, debounceMs: 0 });
    await registry.load();
    expect(registry.get('node-1')?.entries).toEqual([
      { kind: 'loopback', url: 'http://127.0.0.1:8651' },
    ]);
    expect(registry.get('node-1')?.registered_at).toBe(7);
  });
});
