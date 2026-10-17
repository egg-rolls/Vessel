import { afterEach, describe, expect, it } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PeerRegistry } from '../src/transport/registry';
import { makeTempDir, removeTempDir, waitUntil } from './helpers';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('PeerRegistry', () => {
  const dirs: string[] = [];
  const registries: PeerRegistry[] = [];

  const makeRegistry = async (
    nodeId: string,
    peersDir: string,
    overrides: { heartbeatMs?: number; peerTtlMs?: number } = {},
  ) => {
    const registry = await PeerRegistry.create({
      nodeId,
      endpoint: `http://127.0.0.1:${10000 + registries.length}`,
      peersDir,
      heartbeatMs: overrides.heartbeatMs ?? 50,
      peerTtlMs: overrides.peerTtlMs ?? 500,
      agents: () => [{ id: 'owner', state: 'idle', toolNames: ['read'] }],
    });
    registries.push(registry);
    await registry.start();
    return registry;
  };

  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.stop();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  it('writes its own record and discovers peers', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const a = await makeRegistry('A', dir);
    const b = await makeRegistry('B', dir);

    expect(await fileExists(join(dir, 'A.json'))).toBe(true);
    expect(await fileExists(join(dir, 'B.json'))).toBe(true);

    await waitUntil(() => a.peers().some((peer) => peer.nodeId === 'B'));
    const peers = a.peers();
    expect(peers.map((peer) => peer.nodeId).sort()).toEqual(['A', 'B']);
    expect(peers.find((peer) => peer.nodeId === 'A')?.agents[0]?.toolNames).toEqual(['read']);
    expect(peers.find((peer) => peer.nodeId === 'B')?.endpoint).toBeDefined();

    await b.stop();
    expect(await fileExists(join(dir, 'B.json'))).toBe(false);
    await waitUntil(() => !a.peers().some((peer) => peer.nodeId === 'B'));
  });

  it('ignores and cleans stale records', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const stalePath = join(dir, 'dead.json');
    await writeFile(
      stalePath,
      JSON.stringify({
        protocol: 1,
        node_id: 'dead',
        pid: 2_147_483_000,
        endpoint: 'http://127.0.0.1:9',
        started_at: 1,
        heartbeat_at: Date.now() - 60_000,
        agents: [],
      }),
    );
    const registry = await makeRegistry('A', dir);
    await waitUntil(() => !registry.peers().some((peer) => peer.nodeId === 'dead'));
    expect(registry.peers().map((peer) => peer.nodeId)).toEqual(['A']);
    expect(await fileExists(stalePath)).toBe(false);
  });

  it('skips malformed files without failing', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    await writeFile(join(dir, 'bad.json'), '{not-json');
    await writeFile(
      join(dir, 'wrong-protocol.json'),
      JSON.stringify({ protocol: 2, node_id: 'x', pid: 1, endpoint: 'http://127.0.0.1:1' }),
    );
    const registry = await makeRegistry('A', dir);
    await waitUntil(() => registry.peers().length === 1);
    expect(registry.peers().map((peer) => peer.nodeId)).toEqual(['A']);
    expect(registry.degraded).toBe(false);
  });

  it('degrades to local-only when the peers dir is unusable', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const filePath = join(dir, 'not-a-dir');
    await writeFile(filePath, 'x');

    const registry = await PeerRegistry.create({
      nodeId: 'A',
      endpoint: 'http://127.0.0.1:1234',
      peersDir: filePath,
    });
    registries.push(registry);
    await registry.start();

    expect(registry.degraded).toBe(true);
    expect(registry.lastError).toBeDefined();
    expect(registry.peers().map((peer) => peer.nodeId)).toEqual(['A']);
  });

  it('rejects non-loopback endpoints without throwing', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const registry = await PeerRegistry.create({
      nodeId: 'A',
      endpoint: 'http://0.0.0.0:1234',
      peersDir: dir,
    });
    registries.push(registry);
    await registry.start();
    expect(registry.degraded).toBe(true);
    expect(registry.peers().map((peer) => peer.nodeId)).toEqual(['A']);
  });
});
