import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteHubNodeState,
  HUB_NODE_STATE_FILE,
  HUB_NODE_STATUS_FILE,
  HubNodeStateCorruptError,
  readHubNodeState,
  readHubNodeStatus,
  writeHubNodeState,
  writeHubNodeStatus,
} from '../hub/node-state';
import type { HubNodeState } from '../hub/types';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-hub-node-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeState(overrides: Partial<HubNodeState> = {}): HubNodeState {
  return {
    v: 1,
    hub_url: 'https://hub.example:8643',
    hub_id: 'hub-1',
    node_id: 'node-1',
    tenant_id: 'tenant-1',
    pairing_id: 'node-1:tenant-1',
    token_id: 'token-id-1',
    expires_at: 1_800_000_000_000,
    joined_at: 1_700_000_000_000,
    ...overrides,
  };
}

async function corruptError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('hub-node.json', () => {
  it('round-trips a state file', async () => {
    const dir = tempDir();
    const state = makeState({ ca_file: '/etc/vessel/hub-ca.pem', alias: 'home' });
    await writeHubNodeState(dir, state);
    expect(await readHubNodeState(dir)).toEqual(state);
  });

  it('returns undefined when missing and delete is idempotent', async () => {
    const dir = tempDir();
    expect(await readHubNodeState(dir)).toBeUndefined();
    await writeHubNodeState(dir, makeState());
    await deleteHubNodeState(dir);
    expect(await readHubNodeState(dir)).toBeUndefined();
    await deleteHubNodeState(dir);
  });

  it('fails closed when the file is corrupt', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, HUB_NODE_STATE_FILE), '{not json');
    const error = await corruptError(readHubNodeState(dir));
    expect(error).toBeInstanceOf(HubNodeStateCorruptError);
    expect((error as HubNodeStateCorruptError).code).toBe('hub_node_state_corrupt');

    writeFileSync(join(dir, HUB_NODE_STATE_FILE), JSON.stringify({ ...makeState(), v: 2 }));
    const versionError = await corruptError(readHubNodeState(dir));
    expect((versionError as HubNodeStateCorruptError).code).toBe('hub_node_state_corrupt');
  });

  it('never writes a token into the state file', async () => {
    const dir = tempDir();
    const smuggled = { ...makeState(), token: 'super-secret-node-token' } as HubNodeState;
    await writeHubNodeState(dir, smuggled);

    const raw = readFileSync(join(dir, HUB_NODE_STATE_FILE), 'utf8');
    expect(raw).not.toContain('super-secret-node-token');
    expect(raw).not.toContain('"token"');
    expect(raw).toContain('token-id-1');
  });

  it('writes the state file with 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const dir = tempDir();
    await writeHubNodeState(dir, makeState());
    expect(statSync(join(dir, HUB_NODE_STATE_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe('hub-node-status.json', () => {
  it('round-trips a status file', async () => {
    const dir = tempDir();
    await writeHubNodeStatus(dir, {
      v: 1,
      status: 'healthy',
      updated_at: 111,
      hello_at: 222,
    });
    expect(await readHubNodeStatus(dir)).toEqual({
      v: 1,
      status: 'healthy',
      updated_at: 111,
      hello_at: 222,
    });

    await writeHubNodeStatus(dir, {
      v: 1,
      status: 'unreachable',
      last_error: 'disconnected',
      updated_at: 333,
    });
    expect(await readHubNodeStatus(dir)).toEqual({
      v: 1,
      status: 'unreachable',
      last_error: 'disconnected',
      updated_at: 333,
    });
  });

  it('treats a corrupt status file as absent (advisory)', async () => {
    const dir = tempDir();
    expect(await readHubNodeStatus(dir)).toBeUndefined();

    writeFileSync(join(dir, HUB_NODE_STATUS_FILE), '{not json');
    expect(await readHubNodeStatus(dir)).toBeUndefined();

    writeFileSync(
      join(dir, HUB_NODE_STATUS_FILE),
      JSON.stringify({ v: 1, status: 'exploded', updated_at: 1 }),
    );
    expect(await readHubNodeStatus(dir)).toBeUndefined();
  });

  it('writes the status file with 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const dir = tempDir();
    await writeHubNodeStatus(dir, { v: 1, status: 'connecting', updated_at: 1 });
    expect(statSync(join(dir, HUB_NODE_STATUS_FILE)).mode & 0o777).toBe(0o600);
  });
});
