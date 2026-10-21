/**
 * 0.15 session / run 写锁：跨进程互斥、stale 回收、同进程引用计数。
 *
 * 故障形态：两个进程同时写同一 session 文件（静默串写/丢数据）；
 * 或第二个写者没报 session_locked 而继续执行。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSessionLock,
  lockFileName,
  resetHeldSessionLocksForTest,
  SessionLockedError,
  sessionLockPath,
} from '../session-lock';

const dirs: string[] = [];

async function tempTenant(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-session-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetHeldSessionLocksForTest();
  dirs.length = 0;
});

describe('session lock', () => {
  it('second live writer gets session_locked (RPC code conflict)', async () => {
    const tenantDir = await tempTenant();
    const first = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'sess-1',
      pid: 111,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    try {
      let caught: unknown;
      try {
        await acquireSessionLock({
          tenantDir,
          kind: 'session',
          id: 'sess-1',
          pid: 222,
          hostname: 'host-a',
          isPidAlive: () => true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockedError);
      const locked = caught as SessionLockedError;
      expect(locked.code).toBe('conflict');
      expect(locked.reason).toBe('session_locked');
      expect(locked.message.startsWith('session_locked:')).toBe(true);
      expect(locked.owner?.pid).toBe(111);
    } finally {
      await first.release();
    }
  });

  it('dead pid locks are reclaimed', async () => {
    const tenantDir = await tempTenant();
    const path = sessionLockPath(tenantDir, 'session', 'sess-dead');
    await mkdir(join(tenantDir, '.locks', 'sessions'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: 999, started_at: Date.now(), host: 'host-a', session_id: 'sess-dead' }),
      { flag: 'wx' },
    );
    const lock = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'sess-dead',
      pid: 333,
      hostname: 'host-a',
      isPidAlive: (pid) => pid !== 999,
    });
    expect(lock.info.pid).toBe(333);
    await lock.release();
  });

  it('same-process reacquire is a refcount, not a conflict', async () => {
    const tenantDir = await tempTenant();
    const first = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'sess-2',
      pid: 444,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    const second = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'sess-2',
      pid: 444,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    await first.release();
    // 内层引用仍持有 → 另一个 pid 仍应失败。
    await expect(
      acquireSessionLock({
        tenantDir,
        kind: 'session',
        id: 'sess-2',
        pid: 555,
        hostname: 'host-a',
        isPidAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(SessionLockedError);
    await second.release();
    const third = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'sess-2',
      pid: 555,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    await third.release();
  });

  it('session and run locks use separate namespaces', async () => {
    const tenantDir = await tempTenant();
    const session = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'same-id',
      pid: 666,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    const run = await acquireSessionLock({
      tenantDir,
      kind: 'run',
      id: 'same-id',
      pid: 666,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    expect(session.path).not.toBe(run.path);
    await session.release();
    await run.release();
  });

  it('lock file name is sha256 prefix and file mode is 0600', async () => {
    expect(lockFileName('abc')).toBe('ba7816bf8f01cfea.lock');
    const tenantDir = await tempTenant();
    const lock = await acquireSessionLock({
      tenantDir,
      kind: 'session',
      id: 'mode',
      pid: 777,
      hostname: 'host-a',
      isPidAlive: () => true,
    });
    const info = await stat(lock.path);
    expect(info.size).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600);
    }
    await lock.release();
    const names = await readdir(join(tenantDir, '.locks', 'sessions'));
    expect(names).toEqual([]);
  });
});
