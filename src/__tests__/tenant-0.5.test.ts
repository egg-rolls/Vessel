import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DATA_DIR, type VesselConfig } from '../../packages/config/src/index';
import { expandHome, resolveDataDir, resolveTenantPaths } from '../data-paths';
import {
  acquireTenantLock,
  TENANT_LOCK_STALE_MS,
  TenantLock,
  TenantLockError,
  type TenantLockInfo,
} from '../tenant-lock';
import { resolveTenantId } from '../tenant-resolution';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const configWithDefault = (tenantId: string): VesselConfig => ({
  tenant: { default: tenantId },
});

describe('resolveTenantId (0.5)', () => {
  it('优先级 explicit > cli > env > config > default', () => {
    const config = configWithDefault('from-config');

    expect(
      resolveTenantId({
        explicit: 'from-explicit',
        cli: 'from-cli',
        env: { VESSEL_TENANT: 'from-env' },
        config,
      }),
    ).toEqual({ ok: true, tenantId: 'from-explicit', source: 'explicit' });

    expect(
      resolveTenantId({ cli: 'from-cli', env: { VESSEL_TENANT: 'from-env' }, config }),
    ).toEqual({ ok: true, tenantId: 'from-cli', source: 'cli' });

    expect(resolveTenantId({ env: { VESSEL_TENANT: 'from-env' }, config })).toEqual({
      ok: true,
      tenantId: 'from-env',
      source: 'env',
    });

    expect(resolveTenantId({ env: {}, config })).toEqual({
      ok: true,
      tenantId: 'from-config',
      source: 'config',
    });

    expect(resolveTenantId({ env: {} })).toEqual({
      ok: true,
      tenantId: 'default',
      source: 'default',
    });
  });

  it('envTenantId 参数覆盖固定 VESSEL_TENANT 前缀', () => {
    expect(
      resolveTenantId({
        env: { CUSTOM_TENANT: 'custom' },
        envTenantId: 'custom',
        config: configWithDefault('from-config'),
      }),
    ).toEqual({ ok: true, tenantId: 'custom', source: 'env' });
  });

  it('空白值视为未提供', () => {
    expect(
      resolveTenantId({ cli: '  ', env: { VESSEL_TENANT: ' ' }, config: configWithDefault('cfg') }),
    ).toEqual({ ok: true, tenantId: 'cfg', source: 'config' });
  });

  it('非法 tenant id 报错，不静默回退', () => {
    const result = resolveTenantId({ cli: 'Bad/Tenant', env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_tenant');
      expect(result.error).toContain('invalid_tenant_id');
    }
  });
});

describe('data paths (0.5)', () => {
  it('config.dataDir 优先，支持 ~ 展开与相对路径', () => {
    expect(resolveDataDir({ dataDir: '~/vessel-test' }, {})).toBe(
      path.join(os.homedir(), 'vessel-test'),
    );
    expect(resolveDataDir({ dataDir: 'relative-data' }, {})).toBe(path.resolve('relative-data'));
  });

  it('回退 VESSEL_DATA_DIR，再回退 DEFAULT_DATA_DIR', () => {
    expect(resolveDataDir({}, { VESSEL_DATA_DIR: '/var/vessel' })).toBe(
      path.resolve('/var/vessel'),
    );
    expect(resolveDataDir({}, {})).toBe(path.resolve(expandHome(DEFAULT_DATA_DIR)));
  });

  it('tenant 目录布局委托 core TenantPaths', () => {
    const dataDir = path.resolve('/data/vessel');
    const paths = resolveTenantPaths(dataDir, 'work');

    expect(paths.tenant_id).toBe('work');
    expect(paths.root).toBe(path.join(dataDir, 'tenants', 'work'));
    expect(paths.sessions_dir).toBe(path.join(paths.root, 'sessions'));
    expect(paths.runs_dir).toBe(path.join(paths.root, 'runs'));
    expect(paths.events_dir).toBe(path.join(paths.root, 'events'));
    expect(paths.tenant_file).toBe(path.join(paths.root, 'tenant.json'));
    expect(paths.lock_file).toBe(path.join(paths.root, '.lock'));
  });
});

describe('acquireTenantLock (0.5)', () => {
  function lockPathOf(dir: string): string {
    return path.join(dir, '.lock');
  }

  function writeLock(dir: string, info: TenantLockInfo | string): void {
    const value = typeof info === 'string' ? info : JSON.stringify(info);
    fs.writeFileSync(lockPathOf(dir), value, 'utf8');
  }

  it('创建 .lock，内容为冻结形状', async () => {
    const dir = tempDir();
    const lock = await acquireTenantLock({
      tenantDir: dir,
      tenantId: 'work',
      pid: 123,
      hostname: 'test-host',
      now: () => 1760000000000,
      isPidAlive: () => true,
    });

    expect(lock.info).toEqual({ pid: 123, started_at: 1760000000000, host: 'test-host' });
    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(lock.info);

    await lock.release();
    expect(fs.existsSync(lockPathOf(dir))).toBe(false);
  });

  it('存活且未过期的锁 → TenantLockError，附 owner 与可操作提示', async () => {
    const dir = tempDir();
    const first = await acquireTenantLock({
      tenantDir: dir,
      tenantId: 'work',
      pid: 111,
      hostname: 'owner-host',
      now: () => 1000,
      isPidAlive: () => true,
    });

    let caught: unknown;
    try {
      await acquireTenantLock({
        tenantDir: dir,
        tenantId: 'work',
        pid: 222,
        now: () => 2000,
        isPidAlive: () => true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TenantLockError);
    const lockError = caught as TenantLockError;
    expect(lockError.code).toBe('tenant_locked');
    expect(lockError.tenantId).toBe('work');
    expect(lockError.owner).toEqual(first.info);
    expect(lockError.message).toContain('tenant_locked');
    expect(lockError.message).toContain('work');
    expect(lockError.message).toContain('owner-host');
    expect(lockError.message).toContain('--connect');

    await first.release();
  });

  async function captureLocked(promise: Promise<unknown>): Promise<TenantLockError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(TenantLockError);
      return error as TenantLockError;
    }
    throw new Error('expected TenantLockError');
  }

  it('dead pid / 跨主机超过 24h / 不可解析超过宽限的锁被回收', async () => {
    const now = 5_000_000_000_000;

    const deadPidDir = tempDir();
    writeLock(deadPidDir, { pid: 999, started_at: now, host: 'h' });
    const deadPidLock = await acquireTenantLock({
      tenantDir: deadPidDir,
      tenantId: 'work',
      pid: 100,
      now: () => now,
      isPidAlive: () => false,
    });
    expect(deadPidLock.info.pid).toBe(100);
    await deadPidLock.release();

    // 跨主机 + 超过 24h：无法判活，按年龄回收。
    const oldDir = tempDir();
    writeLock(oldDir, {
      pid: 999,
      started_at: now - TENANT_LOCK_STALE_MS - 1,
      host: 'other-host',
    });
    const oldLock = await acquireTenantLock({
      tenantDir: oldDir,
      tenantId: 'work',
      pid: 101,
      hostname: 'me-host',
      now: () => now,
      isPidAlive: () => true,
    });
    expect(oldLock.info.pid).toBe(101);
    await oldLock.release();

    const brokenDir = tempDir();
    writeLock(brokenDir, 'not-json');
    const brokenMtime = fs.statSync(lockPathOf(brokenDir)).mtimeMs;
    const brokenLock = await acquireTenantLock({
      tenantDir: brokenDir,
      tenantId: 'work',
      pid: 102,
      now: () => brokenMtime + 60_000,
      isPidAlive: () => true,
    });
    expect(brokenLock.info.pid).toBe(102);
    await brokenLock.release();
  });

  it('同主机存活 pid 超过 24h 仍不能抢锁（0.7.1 语义）', async () => {
    const now = 5_000_000_000_000;
    const dir = tempDir();
    const owner: TenantLockInfo = {
      pid: 999,
      started_at: now - TENANT_LOCK_STALE_MS - 1,
      host: 'same-host',
    };
    writeLock(dir, owner);

    const error = await captureLocked(
      acquireTenantLock({
        tenantDir: dir,
        tenantId: 'work',
        pid: 100,
        hostname: 'same-host',
        now: () => now,
        isPidAlive: () => true,
      }),
    );

    expect(error.owner).toEqual(owner);
    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(owner);
  });

  it('空 / 坏 JSON 锁在宽限内 → tenant_locked，不删除', async () => {
    for (const content of ['', '{"pid": 999']) {
      const dir = tempDir();
      writeLock(dir, content);
      const mtime = fs.statSync(lockPathOf(dir)).mtimeMs;

      await captureLocked(
        acquireTenantLock({
          tenantDir: dir,
          tenantId: 'work',
          pid: 100,
          now: () => mtime + 1_000,
          unparseableGraceMs: 5_000,
          isPidAlive: () => true,
        }),
      );

      expect(fs.existsSync(lockPathOf(dir))).toBe(true);
    }
  });

  it('空锁超过宽限 → 回收', async () => {
    const dir = tempDir();
    writeLock(dir, '');
    const mtime = fs.statSync(lockPathOf(dir)).mtimeMs;

    const lock = await acquireTenantLock({
      tenantDir: dir,
      tenantId: 'work',
      pid: 100,
      now: () => mtime + 6_000,
      unparseableGraceMs: 5_000,
      isPidAlive: () => true,
    });

    expect(lock.info.pid).toBe(100);
    await lock.release();
  });

  it('回收守卫被占用时第二个回收者失败，且不删除锁', async () => {
    const dir = tempDir();
    const owner: TenantLockInfo = { pid: 999, started_at: 1000, host: 'h' };
    writeLock(dir, owner);
    // 模拟另一个回收者刚拿到守卫（mtime 新鲜）。
    fs.writeFileSync(`${lockPathOf(dir)}.reclaim`, '', 'utf8');

    await captureLocked(
      acquireTenantLock({
        tenantDir: dir,
        tenantId: 'work',
        pid: 100,
        now: () => 2000,
        isPidAlive: () => false,
      }),
    );

    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(owner);
  });

  it('回收守卫超过 10s 视为 stale 并清理后回收', async () => {
    const dir = tempDir();
    writeLock(dir, { pid: 999, started_at: 1000, host: 'h' });
    const guardPath = `${lockPathOf(dir)}.reclaim`;
    fs.writeFileSync(guardPath, '', 'utf8');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(guardPath, old, old);

    const lock = await acquireTenantLock({
      tenantDir: dir,
      tenantId: 'work',
      pid: 100,
      now: () => Date.now(),
      isPidAlive: () => false,
      reclaimGuardStaleMs: 10_000,
    });

    expect(lock.info.pid).toBe(100);
    expect(fs.existsSync(guardPath)).toBe(false);
    await lock.release();
  });

  it('回收前复验：owner 在两次判定间变为存活 → 放弃回收', async () => {
    const dir = tempDir();
    const owner: TenantLockInfo = { pid: 999, started_at: 1000, host: 'same-host' };
    writeLock(dir, owner);

    let calls = 0;
    const isPidAlive = () => {
      calls += 1;
      // 第一次判 stale；拿到守卫复验时 pid 已存活。
      return calls > 1;
    };

    const error = await captureLocked(
      acquireTenantLock({
        tenantDir: dir,
        tenantId: 'work',
        pid: 100,
        hostname: 'same-host',
        now: () => 2000,
        isPidAlive,
      }),
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(error.owner).toEqual(owner);
    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(owner);
  });

  it('release 只删除自己持有的锁', async () => {
    const dir = tempDir();
    const otherInfo: TenantLockInfo = { pid: 999, started_at: 1000, host: 'other' };
    writeLock(dir, otherInfo);

    const lock = new TenantLock(lockPathOf(dir), { pid: 123, started_at: 1000, host: 'me' });
    await lock.release();

    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(otherInfo);
  });

  it('pid + started_at 相同但 host 不同 → 不删除', async () => {
    const dir = tempDir();
    const otherHost: TenantLockInfo = { pid: 123, started_at: 1000, host: 'other-host' };
    writeLock(dir, otherHost);

    const lock = new TenantLock(lockPathOf(dir), { pid: 123, started_at: 1000, host: 'me' });
    await lock.release();

    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(otherHost);
  });

  it('同一 pid 重新加锁后，旧 handle 不会删掉新锁（比较 started_at）', async () => {
    const dir = tempDir();
    const oldInfo: TenantLockInfo = { pid: 123, started_at: 1000, host: 'me' };
    writeLock(dir, oldInfo);

    const oldLock = new TenantLock(lockPathOf(dir), oldInfo);
    const newInfo: TenantLockInfo = { pid: 123, started_at: 2000, host: 'me' };
    writeLock(dir, newInfo);

    await oldLock.release();

    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(newInfo);
  });
});
