import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRuns } from '../src/session/prune';
import { FileRunStore, MemoryRunStore } from '../src/session/run-store';
import type { RunCheckpoint } from '../src/types/run-store';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-prune-'));
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
    status: 'completed',
    messages: [{ role: 'user', content: 'hi' }],
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

async function seed(store: MemoryRunStore, checkpoints: RunCheckpoint[]): Promise<void> {
  for (const item of checkpoints) await store.save(item);
}

describe('pruneRuns (0.4 C2)', () => {
  it('does nothing when no criteria are provided', async () => {
    const store = new MemoryRunStore();
    await seed(store, [checkpoint({ run_id: 'a' }), checkpoint({ run_id: 'b', status: 'failed' })]);

    const result = await pruneRuns(store);

    expect(result).toEqual({ deleted: 0, kept: 2 });
    expect(await store.list()).toHaveLength(2);
  });

  it('deletes every run matching status when only status is given', async () => {
    const store = new MemoryRunStore();
    await seed(store, [
      checkpoint({ run_id: 'a', status: 'completed' }),
      checkpoint({ run_id: 'b', status: 'failed' }),
      checkpoint({ run_id: 'c', status: 'completed' }),
    ]);

    const result = await pruneRuns(store, { status: ['completed'] });

    expect(result).toEqual({ deleted: 2, kept: 0 });
    expect((await store.list()).map((item) => item.run_id)).toEqual(['b']);
  });

  it('treats an explicit empty status array as matching nothing', async () => {
    const store = new MemoryRunStore();
    await seed(store, [checkpoint({ run_id: 'a' })]);

    const result = await pruneRuns(store, { status: [] });

    expect(result).toEqual({ deleted: 0, kept: 0 });
    expect(await store.list()).toHaveLength(1);
  });

  it('deletes only checkpoints older than the age threshold', async () => {
    const store = new MemoryRunStore();
    const now = Date.now();
    await seed(store, [
      checkpoint({ run_id: 'old', updated_at: now - 10_000 }),
      checkpoint({ run_id: 'fresh', updated_at: now }),
    ]);

    const result = await pruneRuns(store, { older_than_ms: 5_000 });

    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect((await store.list()).map((item) => item.run_id)).toEqual(['fresh']);
  });

  it('keeps the latest N by updated_at, breaking ties by run_id ascending', async () => {
    const store = new MemoryRunStore();
    await seed(store, [
      checkpoint({ run_id: 'b', updated_at: 100 }),
      checkpoint({ run_id: 'a', updated_at: 100 }),
      checkpoint({ run_id: 'c', updated_at: 100 }),
      checkpoint({ run_id: 'z', updated_at: 50 }),
    ]);

    const result = await pruneRuns(store, { keep_latest: 2 });

    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(2);
    expect((await store.list()).map((item) => item.run_id).sort()).toEqual(['a', 'b']);
  });

  it('combines status filtering with keep_latest', async () => {
    const store = new MemoryRunStore();
    await seed(store, [
      checkpoint({ run_id: 'done-1', status: 'completed', updated_at: 100 }),
      checkpoint({ run_id: 'done-2', status: 'completed', updated_at: 200 }),
      checkpoint({ run_id: 'done-3', status: 'completed', updated_at: 300 }),
      checkpoint({ run_id: 'fail-1', status: 'failed', updated_at: 50 }),
    ]);

    const result = await pruneRuns(store, {
      status: ['completed'],
      keep_latest: 1,
    });

    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(1);
    expect((await store.list()).map((item) => item.run_id).sort()).toEqual(['done-3', 'fail-1']);
  });

  it('combines keep_latest with older_than_ms', async () => {
    const store = new MemoryRunStore();
    const now = Date.now();
    await seed(store, [
      checkpoint({ run_id: 'keep-new', updated_at: now + 1_000 }),
      checkpoint({ run_id: 'old-1', updated_at: now - 10_000 }),
      checkpoint({ run_id: 'fresh-unkept', updated_at: now }),
    ]);

    const result = await pruneRuns(store, {
      keep_latest: 1,
      older_than_ms: 5_000,
    });

    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(2);
    expect((await store.list()).map((item) => item.run_id).sort()).toEqual([
      'fresh-unkept',
      'keep-new',
    ]);
  });

  it('returns zero counts for an empty store', async () => {
    const store = new MemoryRunStore();

    await expect(pruneRuns(store, { status: ['completed'] })).resolves.toEqual({
      deleted: 0,
      kept: 0,
    });
    await expect(pruneRuns(store)).resolves.toEqual({ deleted: 0, kept: 0 });
  });

  it('pages through more than 200 checkpoints', async () => {
    const store = new MemoryRunStore();
    const checkpoints: RunCheckpoint[] = [];
    for (let i = 0; i < 250; i += 1) {
      checkpoints.push(checkpoint({ run_id: `run-${String(i).padStart(3, '0')}`, updated_at: i }));
    }
    await seed(store, checkpoints);

    const result = await pruneRuns(store, { keep_latest: 5 });

    expect(result.deleted).toBe(245);
    expect(result.kept).toBe(5);
    const remaining = await store.list({ limit: 200 });
    expect(remaining).toHaveLength(5);
  });

  it('propagates delete errors', async () => {
    const store = new MemoryRunStore();
    await seed(store, [checkpoint({ run_id: 'a' })]);
    store.delete = async () => {
      throw new Error('delete boom');
    };

    await expect(pruneRuns(store, { status: ['completed'] })).rejects.toThrow('delete boom');
  });

  it('works with FileRunStore', async () => {
    const dir = await tempDir();
    const store = new FileRunStore({ dir });
    await store.save(checkpoint({ run_id: 'keep', status: 'completed', updated_at: 200 }));
    await store.save(checkpoint({ run_id: 'drop', status: 'failed', updated_at: 100 }));

    const result = await pruneRuns(store, { status: ['failed'] });

    expect(result).toEqual({ deleted: 1, kept: 0 });
    expect(await store.load('drop')).toBeNull();
    expect((await store.load('keep'))?.run_id).toBe('keep');
  });
});
