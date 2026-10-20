/**
 * tenant quota 执行点（A6-14b）：max_runs_per_day / max_sessions / max_storage_bytes。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ConfiguredTenant, createTenantControl } from '../tenant-command';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-tenant-quota-'));
  dirs.push(dir);
  return dir;
}

function controlWith(configured: Record<string, ConfiguredTenant>) {
  return createTenantControl(tmpDir(), { configured });
}

describe('tenant quota (0.5)', () => {
  it('enforces max_runs_per_day across calls', async () => {
    const control = controlWith({ t: { status: 'active', quota: { maxRunsPerDay: 1 } } });

    await control.checkQuota?.('t', 'runs.start');
    await expect(control.checkQuota?.('t', 'runs.start')).rejects.toMatchObject({
      code: 'quota_exceeded',
      details: { tenant_id: 't', limit: 1 },
    });
  });

  it('enforces max_sessions at sessions.create', async () => {
    const control = controlWith({ t: { status: 'active', quota: { maxSessions: 0 } } });

    await expect(control.checkQuota?.('t', 'sessions.create')).rejects.toMatchObject({
      code: 'quota_exceeded',
      details: { tenant_id: 't', limit: 0 },
    });
  });

  it('enforces max_storage_bytes', async () => {
    const control = controlWith({ t: { status: 'active', quota: { maxStorageBytes: 0 } } });

    await expect(control.checkQuota?.('t', 'runs.start')).rejects.toMatchObject({
      code: 'quota_exceeded',
      details: { tenant_id: 't', limit: 0 },
    });
    await expect(control.checkQuota?.('t', 'storage')).rejects.toMatchObject({
      code: 'quota_exceeded',
      details: { tenant_id: 't', limit: 0 },
    });
  });

  it('passes when the tenant has no quota', async () => {
    const control = controlWith({ t: { status: 'active' } });
    await expect(control.checkQuota?.('t', 'runs.start')).resolves.toBeUndefined();
    await expect(control.checkQuota?.('missing', 'runs.start')).resolves.toBeUndefined();
  });

  it('get() exposes config quota in wire format', async () => {
    const control = controlWith({
      t: {
        status: 'active',
        quota: { maxSessions: 2, maxRunsPerDay: 3, maxConcurrentRuns: 4, maxStorageBytes: 5 },
      },
    });

    const info = await control.get('t');
    expect(info?.quota).toEqual({
      max_sessions: 2,
      max_runs_per_day: 3,
      max_concurrent_runs: 4,
      max_storage_bytes: 5,
    });
  });

  it('lists configured tenants with their status', async () => {
    const control = controlWith({
      a: { status: 'active' },
      b: { status: 'disabled' },
    });
    const list = await control.list();
    expect(list.map((tenant) => [tenant.tenant_id, tenant.status])).toEqual([
      ['a', 'active'],
      ['b', 'disabled'],
    ]);
  });
});
