import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHubNodeCredentialStore,
  hashHubNodeToken,
  hubNodeTokensPath,
} from '../hub/node-credential-store';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-node-credential-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

const HUB_ID = 'hub-1';
const NODE = 'node-1';
const TENANT = 'tenant-a';
const PAIRING = `${NODE}:${TENANT}`;

type IssueInput = {
  hub_id: string;
  node_id: string;
  tenant_id: string;
  pairing_id: string;
  ttl_ms?: number;
};

function issueInput(overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    hub_id: HUB_ID,
    node_id: NODE,
    tenant_id: TENANT,
    pairing_id: PAIRING,
    ...overrides,
  };
}

describe('hub node credential store', () => {
  it('issues a token once and authenticates it', async () => {
    const dataDir = await tempDataDir();
    const clock = 1_700_000_000_000;
    const store = await createHubNodeCredentialStore({ dataDir, now: () => clock });

    const issued = await store.issue(issueInput());
    expect(issued.scope).toBe('node');
    expect(issued.hub_id).toBe(HUB_ID);
    expect(issued.node_id).toBe(NODE);
    expect(issued.tenant_id).toBe(TENANT);
    expect(issued.pairing_id).toBe(PAIRING);
    expect(issued.expires_at).toBe(clock + 30 * 24 * 60 * 60 * 1000);

    const record = store.authenticate(issued.token);
    if (record === null) throw new Error('issued token did not authenticate');
    expect(record.token_id).toBe(issued.token_id);
    expect(record.scope).toBe('node');
    expect(record.hub_id).toBe(HUB_ID);
    expect(record.node_id).toBe(NODE);
    expect(record.tenant_id).toBe(TENANT);
    expect(record.pairing_id).toBe(PAIRING);
    expect(record.issued_by).toBe('join');
    expect(record.created_at).toBe(clock);
    expect(record.expires_at).toBe(issued.expires_at);

    expect(store.list()).toHaveLength(1);
  });

  it('loads existing tokens on reopen', async () => {
    const dataDir = await tempDataDir();
    const first = await createHubNodeCredentialStore({ dataDir });
    const issued = await first.issue(issueInput());

    const second = await createHubNodeCredentialStore({ dataDir });
    expect(second.authenticate(issued.token)?.token_id).toBe(issued.token_id);
  });

  it('returns null for unknown, empty and expired tokens', async () => {
    const dataDir = await tempDataDir();
    let clock = 1_700_000_000_000;
    const store = await createHubNodeCredentialStore({ dataDir, now: () => clock });

    const issued = await store.issue(issueInput({ ttl_ms: 1_000 }));
    expect(store.authenticate('not-a-token')).toBeNull();
    expect(store.authenticate('')).toBeNull();
    expect(store.authenticate(issued.token)).not.toBeNull();

    clock += 1_000;
    expect(store.authenticate(issued.token)).toBeNull();
  });

  it('revokes idempotently and notifies listeners only on change', async () => {
    const dataDir = await tempDataDir();
    let clock = 1_700_000_000_000;
    const store = await createHubNodeCredentialStore({ dataDir, now: () => clock });
    const issued = await store.issue(issueInput());

    const notified: string[] = [];
    store.onRevoke((tokenId) => notified.push(tokenId));

    clock += 10;
    const first = await store.revoke(issued.token_id);
    if (first === null) throw new Error('revoke returned null for a known token');
    expect(first).toEqual({ token_id: issued.token_id, revoked_at: clock, changed: true });
    expect(store.authenticate(issued.token)).toBeNull();

    const second = await store.revoke(issued.token_id);
    expect(second).toEqual({ token_id: issued.token_id, revoked_at: clock, changed: false });

    expect(await store.revoke('unknown-token-id')).toBeNull();
    expect(notified).toEqual([issued.token_id]);
  });

  it('revokes every token of a pairing in one pass', async () => {
    const dataDir = await tempDataDir();
    let clock = 1_700_000_000_000;
    const store = await createHubNodeCredentialStore({ dataDir, now: () => clock });

    const one = await store.issue(issueInput());
    const two = await store.issue(issueInput());
    const other = await store.issue(
      issueInput({ node_id: 'node-2', pairing_id: `node-2:${TENANT}` }),
    );

    const notified: string[] = [];
    store.onRevoke((tokenId) => notified.push(tokenId));

    clock += 5;
    expect(await store.revokePairing(PAIRING)).toBe(2);
    expect(store.authenticate(one.token)).toBeNull();
    expect(store.authenticate(two.token)).toBeNull();
    expect(store.authenticate(other.token)).not.toBeNull();
    expect(notified).toEqual([one.token_id, two.token_id]);

    expect(await store.revokePairing(PAIRING)).toBe(0);
    expect(notified).toEqual([one.token_id, two.token_id]);
    expect(await store.revokePairing('missing-pairing')).toBe(0);

    // re-join：保留刚签发的一枚，只吊销旧 token。
    const three = await store.issue(issueInput());
    expect(await store.revokePairing(PAIRING, three.token_id)).toBe(0);
    expect(store.authenticate(three.token)).not.toBeNull();
  });

  it('persists only the token hash, never the plaintext token', async () => {
    const dataDir = await tempDataDir();
    const store = await createHubNodeCredentialStore({ dataDir });
    const issued = await store.issue(issueInput());

    const raw = await readFile(hubNodeTokensPath(dataDir), 'utf8');
    expect(raw).not.toContain(issued.token);
    expect(raw).toContain(hashHubNodeToken(issued.token));

    const parsed = JSON.parse(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0].token_hash).toBe(hashHubNodeToken(issued.token));
    expect(parsed.tokens[0].scope).toBe('node');
    expect(parsed.tokens[0]).not.toHaveProperty('token');
  });

  it('fails closed when the file is corrupt', async () => {
    const dataDir = await tempDataDir();
    await writeFile(hubNodeTokensPath(dataDir), '{ not json');

    let caught: unknown;
    try {
      await createHubNodeCredentialStore({ dataDir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('hub_node_tokens_corrupt');
    expect((caught as Error).message).not.toContain('token_hash');
  });
});
