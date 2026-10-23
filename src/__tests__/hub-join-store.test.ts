import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubJoinStore, type HubJoinErrorCode, hubJoinPath } from '../hub/join-store';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-join-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

/** 返回拒绝的 `code`；未拒绝时返回 undefined。 */
async function rejectionCode(run: () => Promise<unknown>): Promise<HubJoinErrorCode | undefined> {
  try {
    await run();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      return (error as { code?: unknown }).code as HubJoinErrorCode;
    }
    throw error;
  }
  return undefined;
}

const HUB_ID = 'hub-1';
const TENANT = 'tenant-a';
const NODE = 'node-1';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('hub join store', () => {
  it('issues a readable code and consumes it exactly once', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });

    const issued = await store.issue({ tenant_id: TENANT });
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const result = await store.consume({
      code: issued.code,
      hub_id: HUB_ID,
      node_id: NODE,
      tenant_id: TENANT,
    });
    expect(result).toEqual({
      hub_id: HUB_ID,
      tenant_id: TENANT,
      node_id: NODE,
      pairing_id: `${NODE}:${TENANT}`,
    });

    expect(
      await rejectionCode(() =>
        store.consume({ code: issued.code, hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('pairing_used');
  });

  it('normalizes case, whitespace and hyphens', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });
    const issued = await store.issue({ tenant_id: TENANT });

    const messy = ` ${issued.code.toLowerCase().replace('-', ' \t')} `;
    const result = await store.consume({
      code: messy,
      hub_id: HUB_ID,
      node_id: NODE,
      tenant_id: TENANT,
    });
    expect(result.pairing_id).toBe(`${NODE}:${TENANT}`);
  });

  it('persists only the sha256 hash, never the plaintext code', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });
    const issued = await store.issue({ tenant_id: TENANT });

    const raw = await readFile(hubJoinPath(dataDir), 'utf8');
    expect(raw).not.toContain(issued.code);
    expect(raw).toContain(sha256(issued.code));

    const parsed = JSON.parse(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.hub_id).toBe(HUB_ID);
    expect(parsed.tenant_id).toBe(TENANT);
    expect(parsed.code_hash).toBe(sha256(issued.code));
    expect(parsed).not.toHaveProperty('code');
  });

  it('overwrites the previous code on issue', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });

    const first = await store.issue({ tenant_id: TENANT });
    const second = await store.issue({ tenant_id: TENANT });
    expect(second.code).not.toBe(first.code);

    expect(
      await rejectionCode(() =>
        store.consume({ code: first.code, hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('pairing_invalid');
  });

  it('applies the TTL default and clamps 60..3600 seconds', async () => {
    const dataDir = await tempDataDir();
    const clock = 1_700_000_000_000;
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID, now: () => clock });

    const byDefault = await store.issue({ tenant_id: TENANT });
    expect(byDefault.expires_at).toBe(clock + 300_000);

    const tooShort = await store.issue({ tenant_id: TENANT, ttl_s: 1 });
    expect(tooShort.expires_at).toBe(clock + 60_000);

    const tooLong = await store.issue({ tenant_id: TENANT, ttl_s: 99_999 });
    expect(tooLong.expires_at).toBe(clock + 3_600_000);
  });

  it('rejects an expired code', async () => {
    const dataDir = await tempDataDir();
    let clock = 1_700_000_000_000;
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID, now: () => clock });

    const issued = await store.issue({ tenant_id: TENANT, ttl_s: 60 });
    clock = issued.expires_at;

    expect(
      await rejectionCode(() =>
        store.consume({ code: issued.code, hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('pairing_expired');
  });

  it('rejects a code issued by another hub', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });
    const issued = await store.issue({ tenant_id: TENANT });

    expect(
      await rejectionCode(() =>
        store.consume({
          code: issued.code,
          hub_id: 'hub-2',
          node_id: NODE,
          tenant_id: TENANT,
        }),
      ),
    ).toBe('pairing_invalid');
  });

  it('rejects a tenant mismatch', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });
    const issued = await store.issue({ tenant_id: TENANT });

    expect(
      await rejectionCode(() =>
        store.consume({
          code: issued.code,
          hub_id: HUB_ID,
          node_id: NODE,
          tenant_id: 'tenant-b',
        }),
      ),
    ).toBe('tenant_mismatch');
  });

  it('allows only one concurrent consume to succeed', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });
    const issued = await store.issue({ tenant_id: TENANT });

    const input = { code: issued.code, hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT };
    const outcomes = await Promise.allSettled([store.consume(input), store.consume(input)]);

    const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
    const rejected = outcomes.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    if (failure === undefined) throw new Error('expected exactly one rejection');
    expect((failure.reason as { code?: string }).code).toBe('pairing_used');
  });

  it('fails closed on a missing file and on corruption', async () => {
    const dataDir = await tempDataDir();
    const store = createHubJoinStore({ dataDir, hubId: HUB_ID });

    expect(
      await rejectionCode(() =>
        store.consume({ code: 'ABCD-EFGH', hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('pairing_not_found');

    await writeFile(hubJoinPath(dataDir), '{ not json');
    expect(
      await rejectionCode(() =>
        store.consume({ code: 'ABCD-EFGH', hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('hub_join_corrupt');

    await writeFile(hubJoinPath(dataDir), JSON.stringify({ v: 1, code_hash: 'not-a-hash' }));
    expect(
      await rejectionCode(() =>
        store.consume({ code: 'ABCD-EFGH', hub_id: HUB_ID, node_id: NODE, tenant_id: TENANT }),
      ),
    ).toBe('hub_join_corrupt');
  });
});
