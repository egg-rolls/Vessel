import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import { nodeJsonPath, resolveNodeId, resolveNodeIdentity } from '../node-identity';

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

describe('resolveNodeIdentity', () => {
  it('creates node.json with a sanitized hostname-derived name', async () => {
    const dataDir = await tempDataDir();

    const identity = await resolveNodeIdentity({
      dataDir,
      hostname: () => '  Lab\t  Node\u0001  ',
    });

    expect(identity.name).toBe('Lab Node');
    const stored = JSON.parse(await readFile(nodeJsonPath(dataDir), 'utf8')) as {
      node_id: string;
      name: string;
      created_at: number;
    };
    expect(stored).toEqual({
      node_id: identity.nodeId,
      name: 'Lab Node',
      created_at: expect.any(Number),
    });
  });

  it('caps the derived name at 64 chars and falls back to node', async () => {
    const longDir = await tempDataDir();
    const long = await resolveNodeIdentity({
      dataDir: longDir,
      hostname: () => 'x'.repeat(80),
    });
    expect(long.name).toHaveLength(64);

    const emptyDir = await tempDataDir();
    const empty = await resolveNodeIdentity({
      dataDir: emptyDir,
      hostname: () => ' \t\u0001 ',
    });
    expect(empty.name).toBe('node');
  });

  it('reads a legacy node.json without name and derives it without rewriting', async () => {
    const dataDir = await tempDataDir();
    const path = nodeJsonPath(dataDir);
    const record = { node_id: 'node-legacy', created_at: 1_700_000_000_000 };
    await writeFile(path, JSON.stringify(record));

    const identity = await resolveNodeIdentity({
      dataDir,
      hostname: () => 'Legacy Host',
    });

    expect(identity).toEqual({ nodeId: 'node-legacy', name: 'Legacy Host' });
    // 读取不写入：旧文件保持原样（没有 name 字段）。
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
  });

  it('prefers config node_name over node.json and does not rewrite the file', async () => {
    const dataDir = await tempDataDir();
    const path = nodeJsonPath(dataDir);
    const record = { node_id: 'node-cfg', name: 'file-name', created_at: 1 };
    await writeFile(path, JSON.stringify(record));
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
    };

    const identity = await resolveNodeIdentity({
      dataDir,
      configNodeName: 'config-name',
      hostname: () => 'host-name',
      logger,
    });

    expect(identity).toEqual({ nodeId: 'node-cfg', name: 'config-name' });
    expect(JSON.parse(await readFile(path, 'utf8')).name).toBe('file-name');
    expect(warnings).toContain('node.identity.name_config_override');
  });
});
