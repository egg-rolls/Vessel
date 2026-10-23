import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumePairingCode, pairingFilePath, writePairingFile } from '../hub-pairing';
import { createNodeTokenControl } from '../node-token-control';
import { hashNodeToken, hubTokensPath, NodeTokenStore } from '../node-token-store';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-hub-token-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function loadStore(dataDir: string, now?: () => number): Promise<NodeTokenStore> {
  const store = new NodeTokenStore(now ? { dataDir, now } : { dataDir });
  await store.load();
  return store;
}

async function setupControl(): Promise<{
  dataDir: string;
  control: Awaited<ReturnType<typeof createNodeTokenControl>>;
  admin: NonNullable<ReturnType<NodeTokenStore['authenticate']>>;
}> {
  const dataDir = await tempDataDir();
  const bootstrap = await loadStore(dataDir);
  const adminIssue = await bootstrap.issue('admin', 'tenant-a', { ttl_ms: 60 * 60 * 1000 });
  const control = await createNodeTokenControl({
    dataDir,
    tenantId: 'tenant-a',
    nodeId: 'node-1',
  });
  const admin = control.authenticate(adminIssue.token);
  if (admin === null) throw new Error('admin token did not authenticate');
  return { dataDir, control, admin };
}

async function mintPair(
  control: Awaited<ReturnType<typeof createNodeTokenControl>>,
  dataDir: string,
) {
  const code = await writePairingFile({ dataDir, tenantId: 'tenant-a' });
  return control.mintPairingTokens({ hub_id: 'hub-1', code, direction: 'hub' });
}

describe('NodeTokenStore', () => {
  it('persists only the sha256 hash, never the plaintext token', async () => {
    const dataDir = await tempDataDir();
    const store = await loadStore(dataDir);
    const issued = await store.issue('view', 'tenant-a', { ttl_ms: 1000 });

    const raw = await readFile(hubTokensPath(dataDir), 'utf8');
    expect(raw).not.toContain(issued.token);
    expect(raw).toContain(hashNodeToken(issued.token));

    const parsed = JSON.parse(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0].token_hash).toBe(hashNodeToken(issued.token));
    expect(parsed.tokens[0]).not.toHaveProperty('token');
  });

  it('maps scope to principal role and carries tenant / team / hub / token_id', async () => {
    const dataDir = await tempDataDir();
    const store = await loadStore(dataDir);

    const cases = [
      ['view', 'read'],
      ['exchange', 'write'],
      ['control', 'write'],
      ['admin', 'admin'],
    ] as const;

    for (const [scope, role] of cases) {
      const issued = await store.issue(scope, 'tenant-a', {
        hub_id: 'hub-1',
        team_id: scope === 'control' ? 'team-1' : undefined,
        ttl_ms: 1000,
      });
      const principal = store.authenticate(issued.token);
      expect(principal).toMatchObject({
        tenant_id: 'tenant-a',
        role,
        scope,
        token_id: issued.record.token_id,
      });
      if (scope === 'control') expect(principal?.team_id).toBe('team-1');
    }

    expect(store.authenticate('not-a-real-token')).toBeNull();
  });

  it('rejects expired / revoked tokens and hasTokens tracks live tokens', async () => {
    const dataDir = await tempDataDir();
    let clock = 1_700_000_000_000;
    const store = await loadStore(dataDir, () => clock);

    const expiring = await store.issue('view', 'tenant-a', { ttl_ms: 1000 });
    expect(store.hasTokens()).toBe(true);
    expect(store.authenticate(expiring.token)).not.toBeNull();

    clock += 1001;
    expect(store.authenticate(expiring.token)).toBeNull();
    expect(store.hasTokens()).toBe(false);

    const live = await store.issue('exchange', 'tenant-a', { ttl_ms: 1000 });
    expect(store.hasTokens()).toBe(true);

    const revoked = await store.revoke(live.record.token_id);
    expect(revoked).toMatchObject({ token_id: live.record.token_id, changed: true });
    expect(store.authenticate(live.token)).toBeNull();
    expect(store.hasTokens()).toBe(false);

    const again = await store.revoke(live.record.token_id);
    expect(again).toMatchObject({ changed: false, revoked_at: revoked?.revoked_at });
  });

  it('treats a missing file as an empty set but rejects corrupt files', async () => {
    const missingDir = await tempDataDir();
    const empty = await loadStore(missingDir);
    expect(empty.hasTokens()).toBe(false);
    expect(empty.authenticate('anything')).toBeNull();

    const corruptDir = await tempDataDir();
    await writeFile(hubTokensPath(corruptDir), '{"v":1,"tokens":');
    await expect(new NodeTokenStore({ dataDir: corruptDir }).load()).rejects.toMatchObject({
      code: 'hub_tokens_corrupt',
    });

    const invalidDir = await tempDataDir();
    await writeFile(
      hubTokensPath(invalidDir),
      JSON.stringify({
        v: 1,
        tokens: [
          {
            token_id: 't1',
            token_hash: hashNodeToken('x'),
            scope: 'root',
            tenant_id: 'tenant-a',
            issued_by: 'test',
            created_at: 1,
            expires_at: 2,
          },
        ],
      }),
    );
    await expect(new NodeTokenStore({ dataDir: invalidDir }).load()).rejects.toMatchObject({
      code: 'hub_tokens_corrupt',
    });
  });
});

describe('hub pairing', () => {
  it('stores only the code hash and returns a readable plaintext code once', async () => {
    const dataDir = await tempDataDir();
    const code = await writePairingFile({ dataDir, tenantId: 'tenant-a' });

    expect(code).toMatch(
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
    );

    const raw = await readFile(pairingFilePath(dataDir), 'utf8');
    expect(raw).not.toContain(code);
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ v: 1, tenant_id: 'tenant-a' });
    expect(parsed.code_hash).toHaveLength(64);
  });

  it('clamps ttl to 60..3600 seconds', async () => {
    const dataDir = await tempDataDir();
    const now = 1_700_000_000_000;

    await writePairingFile({ dataDir, tenantId: 'tenant-a', ttlSeconds: 5, now });
    let parsed = JSON.parse(await readFile(pairingFilePath(dataDir), 'utf8'));
    expect(parsed.expires_at - now).toBe(60_000);

    await writePairingFile({ dataDir, tenantId: 'tenant-a', ttlSeconds: 99_999, now });
    parsed = JSON.parse(await readFile(pairingFilePath(dataDir), 'utf8'));
    expect(parsed.expires_at - now).toBe(3_600_000);
  });

  it('consumes a code exactly once under concurrent calls', async () => {
    const dataDir = await tempDataDir();
    const code = await writePairingFile({ dataDir, tenantId: 'tenant-a' });

    const settled = await Promise.allSettled([
      consumePairingCode({ dataDir, code }),
      consumePairingCode({ dataDir, code }),
    ]);
    const codes = settled.map((entry) =>
      entry.status === 'rejected' ? (entry.reason as { code?: string }).code : 'ok',
    );
    expect(codes.filter((value) => value === 'ok')).toHaveLength(1);
    expect(codes.filter((value) => value === 'pairing_used')).toHaveLength(1);

    const parsed = JSON.parse(await readFile(pairingFilePath(dataDir), 'utf8'));
    expect(typeof parsed.used_at).toBe('number');
  });

  it('rejects expired, reused, wrong, missing and corrupt codes', async () => {
    const expiredDir = await tempDataDir();
    const now = 1_700_000_000_000;
    const expiredCode = await writePairingFile({
      dataDir: expiredDir,
      tenantId: 'tenant-a',
      ttlSeconds: 60,
      now,
    });
    await expect(
      consumePairingCode({ dataDir: expiredDir, code: expiredCode, now: now + 60_000 }),
    ).rejects.toMatchObject({ code: 'pairing_expired' });

    const reuseDir = await tempDataDir();
    const reuseCode = await writePairingFile({ dataDir: reuseDir, tenantId: 'tenant-a' });
    await consumePairingCode({ dataDir: reuseDir, code: reuseCode });
    await expect(consumePairingCode({ dataDir: reuseDir, code: reuseCode })).rejects.toMatchObject({
      code: 'pairing_used',
    });

    const wrongDir = await tempDataDir();
    const actual = await writePairingFile({ dataDir: wrongDir, tenantId: 'tenant-a' });
    const wrong = actual === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    await expect(consumePairingCode({ dataDir: wrongDir, code: wrong })).rejects.toMatchObject({
      code: 'pairing_invalid',
    });
    await expect(consumePairingCode({ dataDir: wrongDir, code: 'short' })).rejects.toMatchObject({
      code: 'pairing_invalid',
    });
    // 错误的 code 不会消耗真的 code。
    await expect(consumePairingCode({ dataDir: wrongDir, code: actual })).resolves.toMatchObject({
      tenant_id: 'tenant-a',
    });

    const missingDir = await tempDataDir();
    await expect(
      consumePairingCode({ dataDir: missingDir, code: 'ABCD-EFGH' }),
    ).rejects.toMatchObject({ code: 'pairing_not_found' });

    const corruptDir = await tempDataDir();
    await writeFile(pairingFilePath(corruptDir), 'not json');
    await expect(
      consumePairingCode({ dataDir: corruptDir, code: 'ABCD-EFGH' }),
    ).rejects.toMatchObject({ code: 'pairing_corrupt' });
  });
});

describe('createNodeTokenControl', () => {
  it('mints view + exchange tokens after consuming a pairing code', async () => {
    const { dataDir, control } = await setupControl();

    const code = await writePairingFile({ dataDir, tenantId: 'tenant-a' });
    await expect(
      control.mintPairingTokens({ hub_id: 'hub-1', code, direction: 'node' }),
    ).rejects.toMatchObject({ code: 'unsupported_direction' });

    // 'node' 方向在消费 code 之前失败，code 仍可用于 hub 配对。
    const pair = await control.mintPairingTokens({ hub_id: 'hub-1', code, direction: 'hub' });
    expect(pair.node_id).toBe('node-1');
    expect(pair.tenant_id).toBe('tenant-a');
    expect(pair.pairing_id).toBe('node-1:tenant-a');
    expect(pair.view.scope).toBe('view');
    expect(pair.exchange.scope).toBe('exchange');
    expect(pair.view.hub_id).toBe('hub-1');
    expect(pair.exchange.hub_id).toBe('hub-1');
    expect(pair.view.pairing_id).toBe('node-1:tenant-a');
    expect(pair.exchange.pairing_id).toBe('node-1:tenant-a');
    expect(pair.view.expires_at - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const viewPrincipal = control.authenticate(pair.view.token);
    expect(viewPrincipal).toMatchObject({
      tenant_id: 'tenant-a',
      role: 'read',
      scope: 'view',
      hub_id: 'hub-1',
      token_id: pair.view.token_id,
    });
    const exchangePrincipal = control.authenticate(pair.exchange.token);
    expect(exchangePrincipal).toMatchObject({
      tenant_id: 'tenant-a',
      role: 'write',
      scope: 'exchange',
      hub_id: 'hub-1',
      token_id: pair.exchange.token_id,
    });
  });

  it('exchange issues only control tokens scoped to tenant / team / hub and clamps ttl', async () => {
    const { dataDir, control, admin } = await setupControl();
    const pair = await mintPair(control, dataDir);
    const exchangePrincipal = control.authenticate(pair.exchange.token);
    if (exchangePrincipal === null) throw new Error('exchange token did not authenticate');
    const viewPrincipal = control.authenticate(pair.view.token);
    if (viewPrincipal === null) throw new Error('view token did not authenticate');

    const issued = await control.exchange(exchangePrincipal, {
      team_id: 'team-1',
      ttl_s: 999_999,
    });
    expect(issued.scope).toBe('control');
    expect(issued.tenant_id).toBe('tenant-a');
    expect(issued.team_id).toBe('team-1');
    expect(issued.hub_id).toBe('hub-1');
    expect(issued.node_id).toBe('node-1');

    const controlPrincipal = control.authenticate(issued.token);
    expect(controlPrincipal).toMatchObject({
      tenant_id: 'tenant-a',
      role: 'write',
      scope: 'control',
      team_id: 'team-1',
      hub_id: 'hub-1',
      token_id: issued.token_id,
    });

    const metas = await control.list(admin);
    const clamped = metas.find((meta) => meta.token_id === issued.token_id);
    if (clamped === undefined) throw new Error('control token missing from list');
    expect(clamped.expires_at - clamped.created_at).toBe(86_400_000);

    const defaultTtl = await control.exchange(exchangePrincipal, { team_id: 'team-1' });
    const defaultMeta = (await control.list(admin)).find(
      (meta) => meta.token_id === defaultTtl.token_id,
    );
    if (defaultMeta === undefined) throw new Error('default token missing from list');
    expect(defaultMeta.expires_at - defaultMeta.created_at).toBe(3_600_000);

    // view / control 都不能 exchange。
    await expect(control.exchange(viewPrincipal, { team_id: 'team-1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    if (controlPrincipal === null) throw new Error('control token did not authenticate');
    await expect(control.exchange(controlPrincipal, { team_id: 'team-1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('allows admin exchange but rejects wildcard / empty tenant and empty team', async () => {
    const { dataDir, control, admin } = await setupControl();
    await mintPair(control, dataDir);

    const issued = await control.exchange(admin, { team_id: 'team-1' });
    expect(issued.scope).toBe('control');
    expect(issued.tenant_id).toBe('tenant-a');

    const wildcard = { tenant_id: '*', role: 'admin', scope: 'admin' } as const;
    await expect(control.exchange(wildcard, { team_id: 'team-1' })).rejects.toMatchObject({
      code: 'invalid_tenant',
    });
    await expect(control.exchange(admin, { team_id: '' })).rejects.toMatchObject({
      code: 'invalid_team',
    });
  });

  it('revoke is admin-only, idempotent and fires onRevoke once', async () => {
    const { dataDir, control, admin } = await setupControl();
    const pair = await mintPair(control, dataDir);
    const viewPrincipal = control.authenticate(pair.view.token);
    if (viewPrincipal === null) throw new Error('view token did not authenticate');

    const revokedIds: string[] = [];
    control.onRevoke((tokenId) => revokedIds.push(tokenId));

    await expect(control.revoke(viewPrincipal, pair.exchange.token_id)).rejects.toMatchObject({
      code: 'forbidden',
    });

    const first = await control.revoke(admin, pair.exchange.token_id);
    expect(first.token_id).toBe(pair.exchange.token_id);
    expect(typeof first.revoked_at).toBe('number');
    expect(revokedIds).toEqual([pair.exchange.token_id]);
    expect(control.authenticate(pair.exchange.token)).toBeNull();

    const second = await control.revoke(admin, pair.exchange.token_id);
    expect(second.revoked_at).toBe(first.revoked_at);
    expect(revokedIds).toHaveLength(1);

    const metas = await control.list(admin);
    const meta = metas.find((entry) => entry.token_id === pair.exchange.token_id);
    expect(meta?.revoked_at).toBe(first.revoked_at);

    await expect(control.revoke(admin, 'missing-token')).rejects.toMatchObject({
      code: 'token_not_found',
    });
    await expect(control.list(viewPrincipal)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('list never exposes token material', async () => {
    const { dataDir, control, admin } = await setupControl();
    await mintPair(control, dataDir);

    const metas = await control.list(admin);
    expect(metas.length).toBeGreaterThanOrEqual(3);
    for (const meta of metas) {
      expect(meta).not.toHaveProperty('token');
      expect(meta).not.toHaveProperty('token_hash');
    }
  });
});
