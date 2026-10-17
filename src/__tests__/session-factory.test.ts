import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileSessionBackend,
  MemorySessionBackend,
  SQLiteSessionBackend,
} from '../../packages/core/src/index';
import { createSessionBackend } from '../session-factory';

describe('createSessionBackend', () => {
  it('缺省 backend 为 sqlite', () => {
    const backend = createSessionBackend();
    expect(backend).toBeInstanceOf(SQLiteSessionBackend);
    backend.close?.();
  });

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

  it('backend=file 使用 storage_path 作为目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-session-'));
    try {
      const backend = createSessionBackend({
        backend: 'file',
        storagePath: path.join(dir, 'sessions'),
      });
      expect(backend).toBeInstanceOf(FileSessionBackend);
      backend.close?.();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backend=memory 使用内存后端', () => {
    const backend = createSessionBackend({ backend: 'memory' });
    expect(backend).toBeInstanceOf(MemorySessionBackend);
    backend.close?.();
  });
});
