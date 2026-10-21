import { afterEach, describe, expect, it } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEventLog } from '../src/session/session-event-log.js';
import { sessionDirPath, sessionEventsFilePath } from '../src/tenant/tenant-paths.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-event-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function input(sessionId: string, seqLabel = 'e', runId = 'run-1') {
  return {
    session_id: sessionId,
    run_id: runId,
    type: `test.${seqLabel}`,
    ts: 1000,
    data: { label: seqLabel },
  };
}

describe('SessionEventLog（0.18 事件溯源）', () => {
  it('append 按 session 分配单调 seq，read 支持 sinceSeq/limit', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      const first = await log.append(input('s1', 'a'));
      const second = await log.append(input('s1', 'b'));
      const third = await log.append(input('s1', 'c'));
      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
      expect(first.v).toBe(1);
      expect(first.session_id).toBe('s1');
      expect(first.run_id).toBe('run-1');

      const all = await log.read('s1');
      expect(all.map((record) => record.seq)).toEqual([1, 2, 3]);

      const afterFirst = await log.read('s1', { sinceSeq: 1 });
      expect(afterFirst.map((record) => record.seq)).toEqual([2, 3]);

      const limited = await log.read('s1', { limit: 1 });
      expect(limited.map((record) => record.seq)).toEqual([1]);
      expect(await log.read('s1', { limit: 0 })).toEqual([]);
      expect(log.lastPersistedSeq('s1')).toBe(3);
    } finally {
      await log.close();
    }
  });

  it('不同 session 各自从 1 开始；文件为 0600（POSIX）', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await log.append(input('s1', 'a'));
      await log.append(input('s2', 'b'));
      expect((await log.read('s1')).map((r) => r.seq)).toEqual([1]);
      expect((await log.read('s2')).map((r) => r.seq)).toEqual([1]);

      const info = await stat(sessionEventsFilePath(dir, 's1'));
      if (process.platform !== 'win32') {
        expect(info.mode & 0o777).toBe(0o600);
      }
    } finally {
      await log.close();
    }
  });

  it('重启后从文件尾部恢复 seq，并截断崩溃残留的半行', async () => {
    const dir = await tempDir();
    const first = new SessionEventLog({ dir, durable: false });
    await first.append(input('s1', 'a'));
    await first.append(input('s1', 'b'));
    await first.close();

    // 模拟崩溃：最后一条只写了一半，没有换行
    await appendFile(sessionEventsFilePath(dir, 's1'), '{"v":1,"session_id":"s1"', 'utf8');

    const second = new SessionEventLog({ dir, durable: false });
    try {
      const next = await second.append(input('s1', 'c'));
      expect(next.seq).toBe(3);
      const records = await second.read('s1');
      expect(records.map((record) => [record.seq, record.type])).toEqual([
        [1, 'test.a'],
        [2, 'test.b'],
        [3, 'test.c'],
      ]);
    } finally {
      await second.close();
    }
  });

  it('并发 append 仍保持 seq 连续且顺序一致', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await Promise.all(
        Array.from({ length: 50 }, (_, index) => log.append(input('s1', String(index)))),
      );
      const records = await log.read('s1');
      expect(records).toHaveLength(50);
      expect(records.map((record) => record.seq)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 1),
      );
      expect(records.map((record) => record.data)).toEqual(
        Array.from({ length: 50 }, (_, index) => ({ label: String(index) })),
      );
      const content = await readFile(sessionEventsFilePath(dir, 's1'), 'utf8');
      expect(content.trimEnd().split('\n')).toHaveLength(50);
    } finally {
      await log.close();
    }
  });

  it('index.json 只放元数据并记录 derived_upto_seq', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await log.append(input('s1', 'a'));
      await log.updateIndex('s1', {
        title: 'hello',
        preview: 'hello world',
        status: 'completed',
        started_at: 1000,
        updated_at: 2000,
      });
      const index = await log.readIndex('s1');
      expect(index).toMatchObject({
        v: 1,
        session_id: 's1',
        title: 'hello',
        preview: 'hello world',
        status: 'completed',
        started_at: 1000,
        updated_at: 2000,
        event_count: 1,
        derived_upto_seq: 1,
        messages_cached: true,
      });
      expect(index === null ? undefined : Object.keys(index)).not.toContain('messages');
    } finally {
      await log.close();
    }
  });

  it('deleteSession 删除整个目录；不存在返回 false', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await log.append(input('s1', 'a'));
      await log.updateIndex('s1', { title: 't' });
      const sessionDir = sessionDirPath(dir, 's1');
      expect((await stat(sessionDir)).isDirectory()).toBe(true);

      expect(await log.deleteSession('s1')).toBe(true);
      await expect(stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await log.deleteSession('s1')).toBe(false);
    } finally {
      await log.close();
    }
  });

  it('iterate 可遍历单个 session 或全部 session', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await log.append(input('s2', 'b'));
      await log.append(input('s1', 'a'));
      const one = [];
      for await (const record of log.iterate('s1')) one.push(record.type);
      expect(one).toEqual(['test.a']);

      const all = [];
      for await (const record of log.iterate()) all.push(`${record.session_id}:${record.seq}`);
      expect(all).toEqual(['s1:1', 's2:1']);
      expect(await log.listSessions()).toEqual(['s1', 's2']);
    } finally {
      await log.close();
    }
  });
});
