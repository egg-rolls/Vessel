/**
 * 0.15 tenant 双层锁：shared 租约可共存，exclusive 与 shared 不可同时持有。
 *
 * 故障形态：晚发布方没有被先发布方看见 → 两个进程同时写同一 tenant。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTenantLock, TenantLockError } from '../tenant-lock';

const dirs: string[] = [];

async function tempTenant(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-tenant-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  dirs.length = 0;
});

const host = 'host-a';
const alive = (pid: number) => pid !== 999;

describe('tenant shared lock', () => {
  it('two shared leases coexist', async () => {
    const tenantDir = await tempTenant();
    const a = await acquireTenantLock({
      tenantDir,
      tenantId: 't',
      mode: 'shared',
      pid: 101,
      hostname: host,
      isPidAlive: alive,
    });
    const b = await acquireTenantLock({
      tenantDir,
      tenantId: 't',
      mode: 'shared',
      pid: 202,
      hostname: host,
      isPidAlive: alive,
    });
    expect(a.mode).toBe('shared');
    const members = await readdir(join(tenantDir, '.members'));
    expect(members).toHaveLength(2);
    if (process.platform !== 'win32') {
      const memberMode = (await stat(join(tenantDir, '.members', members[0] as string))).mode;
      expect(memberMode & 0o777).toBe(0o600);
    }
    await a.release();
    await b.release();
    expect(await readdir(join(tenantDir, '.members'))).toEqual([]);
  });

  it('shared cannot be acquired while an exclusive lock is live', async () => {
    const tenantDir = await tempTenant();
    const exclusive = await acquireTenantLock({
      tenantDir,
      tenantId: 't',
      mode: 'exclusive',
      pid: 303,
      hostname: host,
      isPidAlive: alive,
    });
    try {
      await expect(
        acquireTenantLock({
          tenantDir,
          tenantId: 't',
          mode: 'shared',
          pid: 404,
          hostname: host,
          isPidAlive: alive,
        }),
      ).rejects.toBeInstanceOf(TenantLockError);
      // 失败的 shared 必须收回自己的租约。
      expect(await readdir(join(tenantDir, '.members'))).toEqual([]);
    } finally {
      await exclusive.release();
    }
  });

  it('exclusive cannot be acquired while a shared lease is live', async () => {
    const tenantDir = await tempTenant();
    const shared = await acquireTenantLock({
      tenantDir,
      tenantId: 't',
      mode: 'shared',
      pid: 505,
      hostname: host,
      isPidAlive: alive,
    });
    try {
      await expect(
        acquireTenantLock({
          tenantDir,
          tenantId: 't',
          mode: 'exclusive',
          pid: 606,
          hostname: host,
          isPidAlive: alive,
        }),
      ).rejects.toBeInstanceOf(TenantLockError);
      // 冲突时 exclusive 必须删掉自己刚发布的 .lock。
      expect(await readdir(tenantDir)).not.toContain('.lock');
    } finally {
      await shared.release();
    }
  });

  it('stale dead members do not block exclusive', async () => {
    const tenantDir = await tempTenant();
    await mkdir(join(tenantDir, '.members'), { recursive: true });
    await writeFile(
      join(tenantDir, '.members', 'old.json'),
      JSON.stringify({ pid: 999, started_at: Date.now(), host }),
      { flag: 'w' },
    );
    const exclusive = await acquireTenantLock({
      tenantDir,
      tenantId: 't',
      mode: 'exclusive',
      pid: 707,
      hostname: host,
      isPidAlive: alive,
    });
    expect(exclusive.mode).toBe('exclusive');
    await exclusive.release();
    expect(await readdir(join(tenantDir, '.members'))).toEqual([]);
  });
});
