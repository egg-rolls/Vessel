import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeJsonPath, resolveNodeId } from '../node-identity';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-node-identity-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

describe('resolveNodeId', () => {
  it('returns the configured id and does not create node.json', async () => {
    const dataDir = await tempDataDir();
    const id = await resolveNodeId({ configNodeId: 'configured-node', dataDir });
    expect(id).toBe('configured-node');
    expect(existsSync(nodeJsonPath(dataDir))).toBe(false);
  });

  it('reuses an existing node.json across calls', async () => {
    const dataDir = await tempDataDir();
    const record = { node_id: 'node-abc_123', created_at: 1_700_000_000_000 };
    await writeFile(nodeJsonPath(dataDir), JSON.stringify(record));

    const first = await resolveNodeId({ dataDir });
    const second = await resolveNodeId({ dataDir });

    expect(first).toBe(record.node_id);
    expect(second).toBe(record.node_id);
  });

  it('generates and persists an id when node.json is missing', async () => {
    const dataDir = await tempDataDir();
    const path = nodeJsonPath(dataDir);

    const first = await resolveNodeId({ dataDir });
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.node_id).toBe(first);
    expect(typeof stored.created_at).toBe('number');

    const second = await resolveNodeId({ dataDir });
    expect(second).toBe(first);
  });

  it('throws node_identity_corrupt for a damaged file', async () => {
    const dataDir = await tempDataDir();
    const path = nodeJsonPath(dataDir);
    await writeFile(path, '{"node_id": ');

    let error: unknown;
    try {
      await resolveNodeId({ dataDir });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path);
    expect(error).toMatchObject({ code: 'node_identity_corrupt' });
  });
});
