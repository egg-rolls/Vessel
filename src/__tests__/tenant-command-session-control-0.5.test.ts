import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventStream,
  MemorySessionBackend,
  type RunEvent,
  type RunState,
  resolveTenantPaths,
} from '../../packages/core/src/index';
import { createSessionControl, SessionNotFoundError } from '../session-control';
import {
  type TenantMeta,
  tenantCreateCommand,
  tenantGetCommand,
  tenantListCommand,
  tenantUpdateCommand,
} from '../tenant-command';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-tenant-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenant command (0.5)', () => {
  it('create → get → list，meta 形状冻结', async () => {
    const dataDir = tempDir();
    const now = 1_760_000_000_000;

    const created = await tenantCreateCommand('work', {
      dataDir,
      name: 'Work',
      json: true,
      now: () => now,
    });
    expect(created.exitCode).toBe(0);
    const meta = JSON.parse(created.stdout) as TenantMeta;
    expect(meta).toEqual({
      tenant_id: 'work',
      name: 'Work',
      created_at: now,
      status: 'active',
    });

    const paths = resolveTenantPaths(dataDir, 'work');
    expect(JSON.parse(fs.readFileSync(paths.tenant_file, 'utf8'))).toEqual(meta);

    const got = await tenantGetCommand('work', { dataDir, json: true });
    expect(got.exitCode).toBe(0);
    expect(JSON.parse(got.stdout)).toEqual(meta);

    const listed = await tenantListCommand({ dataDir, json: true });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([meta]);
  });

  it('重复 create → conflict；非法 id → exit 2；缺失 get → exit 1', async () => {
    const dataDir = tempDir();
    await tenantCreateCommand('work', { dataDir });

    const duplicate = await tenantCreateCommand('work', { dataDir });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain('conflict');

    const invalid = await tenantCreateCommand('Bad/Id', { dataDir });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain('invalid_tenant_id');

    const missing = await tenantGetCommand('missing', { dataDir });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('not_found');
  });

  it('update 修改 name/status 并持久化', async () => {
    const dataDir = tempDir();
    await tenantCreateCommand('work', { dataDir, name: 'Work' });

    const updated = await tenantUpdateCommand('work', {
      dataDir,
      name: 'Work 2',
      status: 'disabled',
      json: true,
    });
    expect(updated.exitCode).toBe(0);

    const got = await tenantGetCommand('work', { dataDir, json: true });
    expect(JSON.parse(got.stdout)).toEqual({
      tenant_id: 'work',
      name: 'Work 2',
      created_at: expect.any(Number),
      status: 'disabled',
    });
  });

  it('list 对缺失 meta 的目录补齐展示且不写盘', async () => {
    const dataDir = tempDir();
    fs.mkdirSync(path.join(dataDir, 'tenants', 'orphan'), { recursive: true });

    const listed = await tenantListCommand({ dataDir, json: true });
    const tenants = JSON.parse(listed.stdout) as TenantMeta[];

    expect(tenants).toEqual([
      { tenant_id: 'orphan', name: 'orphan', created_at: 0, status: 'active' },
    ]);
    expect(fs.existsSync(resolveTenantPaths(dataDir, 'orphan').tenant_file)).toBe(false);
  });

  it('update 遇到存活锁 → exit 1 tenant_locked', async () => {
    const dataDir = tempDir();
    await tenantCreateCommand('work', { dataDir });
    const paths = resolveTenantPaths(dataDir, 'work');
    const now = 1_760_000_000_000;
    fs.writeFileSync(
      paths.lock_file,
      JSON.stringify({ pid: 999, started_at: now, host: 'other-host' }),
      'utf8',
    );

    const result = await tenantUpdateCommand('work', {
      dataDir,
      status: 'disabled',
      isPidAlive: () => true,
      now: () => now,
      pid: 123,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('tenant_locked');
  });
});

describe('session control (0.5)', () => {
  function saveSession(sessionId: string): RunState {
    const state: RunState = {
      run_id: `run-${sessionId}`,
      session_id: sessionId,
      messages: [{ role: 'user', content: 'hello' }],
      started_at: 1000,
      status: 'completed',
      title: 'Old title',
    };
    return state;
  }

  it('rename 修改 title 并保存', async () => {
    const backend = new MemorySessionBackend();
    const state = saveSession('s1');
    await backend.save(state);

    const dataDir = tempDir();
    const control = createSessionControl({
      session: backend,
      paths: resolveTenantPaths(dataDir, 'acme'),
    });

    await control.rename('s1', 'New title');
    const loaded = await backend.load('s1');
    expect(loaded?.title).toBe('New title');
    expect(loaded?.session_id).toBe('s1');
  });

  it('rename 不存在 → not_found', async () => {
    const backend = new MemorySessionBackend();
    const control = createSessionControl({
      session: backend,
      paths: resolveTenantPaths(tempDir(), 'acme'),
    });

    await expect(control.rename('missing', 'x')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('delete 委托注入实现（含 paths / runStore）', async () => {
    const backend = new MemorySessionBackend();
    const paths = resolveTenantPaths(tempDir(), 'acme');
    let captured: { sessionId: string; eventsDir: string; hasRunStore: boolean } | undefined;

    const control = createSessionControl({
      session: backend,
      paths,
      runStore: undefined,
      deleteSessionData: async (sessionId, opts) => {
        captured = {
          sessionId,
          eventsDir: opts.paths.events_dir,
          hasRunStore: opts.runStore !== undefined,
        };
        return { sessions_deleted: 1, runs_deleted: 2, events_deleted: 3 };
      },
    });

    const result = await control.delete('s1');
    expect(result).toEqual({ sessions_deleted: 1, runs_deleted: 2, events_deleted: 3 });
    expect(captured).toEqual({
      sessionId: 's1',
      eventsDir: paths.events_dir,
      hasRunStore: false,
    });
  });

  it('默认 delete 走 core deleteSessionData，并发布 session.deleted', async () => {
    const backend = new MemorySessionBackend();
    const state = saveSession('s1');
    await backend.save(state);

    const events = new MemoryEventStream();
    const control = createSessionControl({
      session: backend,
      events,
      tenantId: 'acme',
      paths: resolveTenantPaths(tempDir(), 'acme'),
    });

    const result = await control.delete('s1');
    expect(result.sessions_deleted).toBe(1);
    expect(await backend.load('s1')).toBeNull();

    const deleted = events.getHistory().find((event: RunEvent) => event.type === 'session.deleted');
    expect(deleted).toBeDefined();
    expect(deleted?.tenant_id).toBe('acme');
    expect(deleted?.data).toMatchObject({
      session_id: 's1',
      sessions_deleted: 1,
      runs_deleted: 0,
      events_deleted: 0,
    });
  });
});
