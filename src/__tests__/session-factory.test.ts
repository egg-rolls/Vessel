import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteSessionBackend } from '../../packages/core/src/index';
import { createSessionBackend } from '../session-factory';

describe('createSessionBackend', () => {
  it('backend=sqlite 使用 storage_path 作为数据库文件路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-session-'));
    try {
      const backend = createSessionBackend({
        backend: 'sqlite',
        storagePath: path.join(dir, 'custom.db'),
      });
      expect(backend).toBeInstanceOf(SQLiteSessionBackend);
      backend.close?.();
      expect(fs.existsSync(path.join(dir, 'custom.db'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sqlite 缺省落到 <tenant>/sessions.db，两个 tenant 互不可见', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-session-'));
    try {
      const aDir = path.join(root, 'tenants', 'a');
      const bDir = path.join(root, 'tenants', 'b');
      const aDb = path.join(aDir, 'sessions.db');
      const bDb = path.join(bDir, 'sessions.db');

      const a = createSessionBackend(
        { backend: 'sqlite' },
        { tenantSessionsDbPath: aDb, tenantId: 'a' },
      );
      const b = createSessionBackend(
        { backend: 'sqlite' },
        { tenantSessionsDbPath: bDb, tenantId: 'b' },
      );

      await a.save({
        run_id: 'run-a',
        session_id: 's-a',
        messages: [{ role: 'user', content: 'a' }],
        started_at: 1000,
        status: 'completed',
      });
      await b.save({
        run_id: 'run-b',
        session_id: 's-b',
        messages: [{ role: 'user', content: 'b' }],
        started_at: 1000,
        status: 'completed',
      });

      expect(fs.existsSync(aDb)).toBe(true);
      expect(fs.existsSync(bDb)).toBe(true);
      expect((await a.load('s-a'))?.tenant_id).toBe('a');
      expect(await a.load('s-b')).toBeNull();
      expect(await b.load('s-a')).toBeNull();

      a.close?.();
      b.close?.();
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows 上 sqlite 句柄释放可能滞后；临时目录留给系统清理
      }
    }
  });

  it('file 后端传 tenantId：共享 storagePath 下 load/listRich 隔离', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-session-file-'));
    try {
      const shared = path.join(root, 'shared');
      const a = createSessionBackend(
        { backend: 'file', storagePath: shared },
        { tenantSessionsDir: path.join(root, 'a', 'sessions'), tenantId: 'a' },
      );
      const b = createSessionBackend(
        { backend: 'file', storagePath: shared },
        { tenantSessionsDir: path.join(root, 'b', 'sessions'), tenantId: 'b' },
      );

      await a.save({
        run_id: 'run-a',
        session_id: 's-a',
        messages: [{ role: 'user', content: 'a' }],
        started_at: 1000,
        status: 'completed',
      });
      await b.save({
        run_id: 'run-b',
        session_id: 's-b',
        messages: [{ role: 'user', content: 'b' }],
        started_at: 2000,
        status: 'completed',
      });

      expect((await a.load('s-a'))?.tenant_id).toBe('a');
      expect(await a.load('s-b')).toBeNull();
      expect(await b.load('s-a')).toBeNull();
      expect((await a.listRich()).map((s) => s.session_id)).toEqual(['s-a']);
      expect((await b.listRich()).map((s) => s.session_id)).toEqual(['s-b']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('file 显式 storagePath 也 warn tenant escape', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createSessionBackend(
        { backend: 'file', storagePath: path.join(os.tmpdir(), 'shared-sessions') },
        { tenantSessionsDir: path.join(os.tmpdir(), 'tenant', 'sessions'), tenantId: 'acme' },
      );
      expect(warn.mock.calls.some((call) => String(call[0]).includes('escapes tenant'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('显式 storagePath 优先并 warn tenant escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-session-'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const explicit = path.join(root, 'custom.db');
      const backend = createSessionBackend(
        { backend: 'sqlite', storagePath: explicit },
        { tenantSessionsDbPath: path.join(root, 'tenant', 'sessions.db'), tenantId: 'acme' },
      );
      expect(backend).toBeInstanceOf(SQLiteSessionBackend);
      expect(fs.existsSync(explicit)).toBe(true);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('escapes tenant'))).toBe(true);
      backend.close?.();
    } finally {
      warn.mockRestore();
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows 上 sqlite 句柄释放可能滞后；临时目录留给系统清理
      }
    }
  });
});
