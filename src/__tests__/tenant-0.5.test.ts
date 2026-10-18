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

  it('dead pid / 超过 24h / 无法解析的锁视为 stale 并回收', async () => {
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

    const oldDir = tempDir();
    writeLock(oldDir, {
      pid: 999,
      started_at: now - TENANT_LOCK_STALE_MS - 1,
      host: 'h',
    });
    const oldLock = await acquireTenantLock({
      tenantDir: oldDir,
      tenantId: 'work',
      pid: 101,
      now: () => now,
      isPidAlive: () => true,
    });
    expect(oldLock.info.pid).toBe(101);
    await oldLock.release();

    const brokenDir = tempDir();
    writeLock(brokenDir, 'not-json');
    const brokenLock = await acquireTenantLock({
      tenantDir: brokenDir,
      tenantId: 'work',
      pid: 102,
      now: () => now,
      isPidAlive: () => true,
    });
    expect(brokenLock.info.pid).toBe(102);
    await brokenLock.release();
  });

  it('release 只删除自己持有的锁', async () => {
    const dir = tempDir();
    const otherInfo: TenantLockInfo = { pid: 999, started_at: 1000, host: 'other' };
    writeLock(dir, otherInfo);

    const lock = new TenantLock(lockPathOf(dir), { pid: 123, started_at: 1000, host: 'me' });
    await lock.release();

    expect(JSON.parse(fs.readFileSync(lockPathOf(dir), 'utf8'))).toEqual(otherInfo);
  });
});
