import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionCorruptError } from '../src/session/file-backend';
import { FileRunStore, MemoryRunStore } from '../src/session/run-store';
import { type RunCheckpoint, RunResumeError, type RunStore } from '../src/types/run-store';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-runs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-1',
    session_id: 'session-1',
    status: 'running',
    messages: [{ role: 'user', content: 'hi' }],
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

function ids(checkpoints: RunCheckpoint[]): string[] {
  return checkpoints.map((item) => item.run_id);
}

async function seedList(store: RunStore): Promise<void> {
  await store.save(checkpoint({ run_id: 'a', updated_at: 100, session_id: 's1' }));
  await store.save(
    checkpoint({ run_id: 'c', updated_at: 200, session_id: 's1', status: 'completed' }),
  );
  await store.save(
    checkpoint({ run_id: 'b', updated_at: 200, session_id: 's2', status: 'interrupted' }),
  );
}

describe('MemoryRunStore', () => {
  it('save/load 返回等值快照，外部修改不污染 store', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint());

    const loaded = await store.load('run-1');
    expect(loaded).toEqual(checkpoint());

    const first = loaded?.messages[0];
    if (first) first.content = 'mutated';
    expect((await store.load('run-1'))?.messages[0]?.content).toBe('hi');
    expect(await store.load('missing')).toBeNull();
  });

  it('list：过滤、updated_at 倒序、同值 run_id 升序、默认 50 / 最大 200', async () => {
    const store = new MemoryRunStore();
    await seedList(store);

    expect(ids(await store.list())).toEqual(['b', 'c', 'a']);
    expect(ids(await store.list({ status: 'completed' }))).toEqual(['c']);
    expect(ids(await store.list({ session_id: 's2' }))).toEqual(['b']);
    expect(await store.list({ limit: 0 })).toEqual([]);

    for (let i = 0; i < 55; i += 1) {
      await store.save(checkpoint({ run_id: `bulk-${String(i).padStart(2, '0')}`, updated_at: i }));
    }
    expect((await store.list()).length).toBe(50);

    for (let i = 0; i < 210; i += 1) {
      await store.save(checkpoint({ run_id: `max-${String(i).padStart(3, '0')}`, updated_at: i }));
    }
    expect((await store.list()).length).toBe(50);
    expect((await store.list({ limit: 999 })).length).toBe(200);
  });

  it('list offset：跳过排序后的前 N 条，越界返回空，负数/非法按 0', async () => {
    const store = new MemoryRunStore();
    await seedList(store); // ['b', 'c', 'a']

    expect(ids(await store.list({ offset: 0 }))).toEqual(['b', 'c', 'a']);
    expect(ids(await store.list({ offset: 1 }))).toEqual(['c', 'a']);
    expect(ids(await store.list({ offset: 2, limit: 1 }))).toEqual(['a']);
    expect(await store.list({ offset: 3 })).toEqual([]);
    expect(await store.list({ offset: 999 })).toEqual([]);
    expect(ids(await store.list({ offset: -5 }))).toEqual(['b', 'c', 'a']);
    expect(ids(await store.list({ offset: Number.NaN }))).toEqual(['b', 'c', 'a']);
  });

  it('delete 不存在不抛，覆盖写取最后一次', async () => {
    const store = new MemoryRunStore();
    await store.save(checkpoint({ messages: [{ role: 'user', content: 'first' }] }));
    await store.save(checkpoint({ messages: [{ role: 'user', content: 'second' }] }));
    expect((await store.load('run-1'))?.messages[0]?.content).toBe('second');

    await store.delete('run-1');
    expect(await store.load('run-1')).toBeNull();
    await store.delete('run-1');
  });
});

describe('FileRunStore', () => {
  it('跨实例持久化；目录内不残留临时文件且 JSON 完整', async () => {
    const dir = await tempDir();
    const store = new FileRunStore({ dir });
    await store.save(checkpoint());

    const reloaded = await new FileRunStore({ dir }).load('run-1');
    expect(reloaded).toEqual(checkpoint());

    const entries = await readdir(dir);
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
    const jsonEntries = entries.filter((entry) => entry.endsWith('.json'));
    expect(jsonEntries.length).toBe(1);
    const raw = await readFile(join(dir, jsonEntries[0] ?? ''), 'utf8');
    expect(JSON.parse(raw) as RunCheckpoint).toEqual(checkpoint());
  });

  it('list 排序/过滤/limit 与 Memory 语义一致', async () => {
    const memory = new MemoryRunStore();
    const file = new FileRunStore({ dir: await tempDir() });
    await seedList(memory);
    await seedList(file);

    expect(ids(await file.list())).toEqual(ids(await memory.list()));
    expect(ids(await file.list({ status: 'completed' }))).toEqual(
      ids(await memory.list({ status: 'completed' })),
    );
    expect(ids(await file.list({ session_id: 's2' }))).toEqual(
      ids(await memory.list({ session_id: 's2' })),
    );
    expect(await file.list({ limit: 0 })).toEqual([]);
    expect(ids(await file.list({ limit: 2 }))).toEqual(['b', 'c']);
    expect(ids(await file.list({ offset: 1, limit: 2 }))).toEqual(['c', 'a']);
    expect(await file.list({ offset: 3 })).toEqual([]);
  });

  it('损坏 JSON / 形状不合法 → load=null，list 跳过', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    await writeFile(join(dir, 'shape.json'), JSON.stringify({ run_id: 1 }), 'utf8');

    const store = new FileRunStore({ dir });
    expect(await store.load('broken')).toBeNull();
    expect(await store.load('shape')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("tenant B cannot overwrite tenant A's checkpoint with the same run id", async () => {
    const dir = await tempDir();
    const a = new FileRunStore({ dir, tenantId: 'a' });
    const b = new FileRunStore({ dir, tenantId: 'b' });
    await a.save(checkpoint({ messages: [{ role: 'user', content: 'checkpoint a' }] }));

    const error = await b.save(checkpoint()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('tenant_mismatch: checkpoint run-1 belongs to a');
    const onDisk = JSON.parse(
      await readFile(join(dir, `${encodeURIComponent('run-1')}.json`), 'utf8'),
    ) as RunCheckpoint;
    expect(onDisk.tenant_id).toBe('a');
    expect(onDisk.messages[0]?.content).toBe('checkpoint a');
  });

  it('save over a corrupt checkpoint throws SessionCorruptError and keeps the bytes', async () => {
    const dir = await tempDir();
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ not json', 'utf8');
    const store = new FileRunStore({ dir, tenantId: 'a' });

    const error = await store.save(checkpoint({ run_id: 'broken' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SessionCorruptError);
    expect((error as SessionCorruptError).path).toContain('broken.json');
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });

  it('delete 后 load 为 null；不存在不抛', async () => {
    const store = new FileRunStore({ dir: await tempDir() });
    await store.save(checkpoint());
    await store.delete('run-1');
    expect(await store.load('run-1')).toBeNull();
    await store.delete('run-1');
  });

  it('tenant 模式 delete 不删除其它 tenant 的 checkpoint（A5）', async () => {
    const dir = await tempDir();
    const tenantA = new FileRunStore({ dir, tenantId: 'a' });
    const tenantB = new FileRunStore({ dir, tenantId: 'b' });
    await tenantA.save(checkpoint({ tenant_id: 'a' }));

    // 跨 tenant 读不到，也不能通过 delete 删除
    expect(await tenantB.load('run-1')).toBeNull();
    await tenantB.delete('run-1');
    expect(await tenantA.load('run-1')).not.toBeNull();

    // 归属 tenant 可以删除
    await tenantA.delete('run-1');
    expect(await tenantA.load('run-1')).toBeNull();
  });

  it('tenant 模式 delete 对缺失文件 no-op，对损坏文件抛 SessionCorruptError 且不删除', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    const store = new FileRunStore({ dir, tenantId: 'a' });

    await store.delete('missing');

    const error = await store.delete('broken').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionCorruptError);
    expect((error as SessionCorruptError).path).toContain('broken.json');
    // 归属未知时不 unlink
    expect((await readdir(dir)).includes('broken.json')).toBe(true);

    // 非 tenant 模式保持 0.3 旧语义：损坏 → load null，delete 不额外校验
    const loose = new FileRunStore({ dir });
    expect(await loose.load('broken')).toBeNull();
    await loose.delete('broken');
    expect((await readdir(dir)).includes('broken.json')).toBe(false);
  });

  it('run_id 编码后不逃出目录；空 run_id 抛错', async () => {
    const dir = await tempDir();
    const store = new FileRunStore({ dir });
    await store.save(checkpoint({ run_id: '../escape' }));

    const entries = await readdir(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain('/');
    expect(await store.load('../escape')).not.toBeNull();
    expect(await readdir(join(dir, '..'))).not.toContain('escape.json');

    await expect(store.save(checkpoint({ run_id: '' }))).rejects.toThrow('invalid_run_id');
  });

  it('同一 run 的并发 save 串行执行，最终文件始终是完整 JSON', async () => {
    const store = new FileRunStore({ dir: await tempDir() });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i += 1) {
      writes.push(
        store.save(
          checkpoint({
            messages: [{ role: 'user', content: `n=${i}` }],
            updated_at: 1_000 + i,
          }),
        ),
      );
    }
    await Promise.all(writes);

    const loaded = await store.load('run-1');
    expect(loaded?.messages[0]?.content).toBe('n=9');
    expect(loaded?.updated_at).toBe(1_009);
  });

  it('去重后的默认 limit=50', async () => {
    const store = new FileRunStore({ dir: await tempDir() });
    for (let i = 0; i < 55; i += 1) {
      await store.save(checkpoint({ run_id: `run-${String(i).padStart(2, '0')}`, updated_at: i }));
    }
    expect((await store.list()).length).toBe(50);
  });
});

describe('RunResumeError', () => {
  it('保留 code / runId / name 与 detail', () => {
    const error = new RunResumeError('run_not_resumable', 'run-9', 'completed');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RunResumeError');
    expect(error.code).toBe('run_not_resumable');
    expect(error.runId).toBe('run-9');
    expect(error.message).toBe('run_not_resumable: completed');

    const plain = new RunResumeError('run_not_found', 'missing');
    expect(plain.message).toBe('run_not_found');
  });
});
