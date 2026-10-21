import { afterEach, describe, expect, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEventLog, SessionEventLogDeletedError } from '../src/session/session-event-log.js';
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

  it('轮换写者（两个实例交替写）不会复用 seq', async () => {
    const dir = await tempDir();
    const first = new SessionEventLog({ dir, durable: false });
    const second = new SessionEventLog({ dir, durable: false });
    try {
      expect((await first.append(input('s1', 'a'))).seq).toBe(1);
      // second 初始化时从文件尾恢复 → 2
      expect((await second.append(input('s1', 'b'))).seq).toBe(2);
      // first 的 expectedSize 已过期；append 前 stat 发现变化并抬高 seq → 3
      expect((await first.append(input('s1', 'c'))).seq).toBe(3);
      expect((await second.append(input('s1', 'd'))).seq).toBe(4);
      expect((await first.append(input('s1', 'e'))).seq).toBe(5);

      const records = await first.read('s1');
      expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(records.map((record) => record.seq)).size).toBe(5);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('LRU 淘汰 drain 期间重开同一 session 不会重复 seq（50 轮）', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false, maxOpenWriters: 1 });
    try {
      for (let round = 0; round < 50; round += 1) {
        // 同一 session 两条在途写入
        const first = log.append(input('s1', `a${round}`));
        const second = log.append(input('s1', `b${round}`));
        // 打开另一个 session 触发 LRU 淘汰 s1（drain 尚未完成）
        const other = log.append(input('s2', `x${round}`));
        // 立刻重开 s1（再次淘汰 s2）；新 writer 必须排在上一个 s1 drain 之后
        const third = log.append(input('s1', `c${round}`));
        await Promise.all([first, second, other, third]);
      }

      const seqs = (await log.read('s1')).map((record) => record.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
      expect(seqs).toHaveLength(150);
    } finally {
      await log.close();
    }
  });

  it('release 关闭句柄后再次 append 会重新恢复 seq', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      expect((await log.append(input('s1', 'a'))).seq).toBe(1);
      await log.release('s1');
      expect(log.lastPersistedSeq('s1')).toBeUndefined();
      expect((await log.append(input('s1', 'b'))).seq).toBe(2);
    } finally {
      await log.close();
    }
  });

  it('文件被外部删除后 append 抛错，不静默写回已删除 inode（POSIX）', async () => {
    if (process.platform === 'win32') return; // Windows 不允许删除打开中的文件
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      await log.append(input('s1', 'a'));
      await rm(sessionDirPath(dir, 's1'), { recursive: true, force: true });
      await expect(log.append(input('s1', 'b'))).rejects.toBeInstanceOf(
        SessionEventLogDeletedError,
      );
    } finally {
      await log.close();
    }
  });

  it('read 按 seq 升序返回，并过滤其它 session_id 的记录', async () => {
    const dir = await tempDir();
    const log = new SessionEventLog({ dir, durable: false });
    try {
      const sessionDir = sessionDirPath(dir, 's1');
      await mkdir(sessionDir, { recursive: true });
      const line = (seq: number, sessionId = 's1') =>
        `${JSON.stringify({
          v: 1,
          session_id: sessionId,
          run_id: 'run-1',
          seq,
          ts: seq,
          type: 'test.x',
          data: { seq },
        })}\n`;
      // 轮换写者/坏文件：行序 3,1,2，并混入另一个 session 的记录
      await writeFile(
        sessionEventsFilePath(dir, 's1'),
        `${line(3)}${line(1)}${line(99, 'other')}${line(2)}`,
        'utf8',
      );

      expect((await log.read('s1')).map((record) => record.seq)).toEqual([1, 2, 3]);
      expect((await log.read('s1', { limit: 2 })).map((record) => record.seq)).toEqual([1, 2]);
      expect((await log.read('s1', { sinceSeq: 1 })).map((record) => record.seq)).toEqual([2, 3]);
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
