import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCheckpoint, RunEvent } from '../src/index';
import { MemoryRunStore, pruneTrace } from '../src/index';

const DAY = 86_400_000;
const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-prune-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

function line(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

async function seed(dir: string, runId: string, events: RunEvent[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${encodeURIComponent(runId)}.jsonl`);
  await writeFile(path, events.map(line).join(''), 'utf8');
  return path;
}

function terminal(runId: string, ts: number): RunEvent[] {
  return [
    { type: 'run.started', run_id: runId, data: {}, ts: ts - 1 },
    { type: 'run.completed', run_id: runId, data: {}, ts },
  ];
}

function checkpoint(runId: string, status: RunCheckpoint['status']): RunCheckpoint {
  return {
    run_id: runId,
    session_id: 's1',
    status,
    messages: [],
    created_at: 1,
    updated_at: 1,
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('pruneTrace (0.5 E9)', () => {
  it('does nothing without limits', async () => {
    const dir = tempDir();
    await seed(dir, 'r1', terminal('r1', 1));
    await seed(dir, 'r2', terminal('r2', 2));

    expect(await pruneTrace(dir)).toEqual({ deleted_runs: 0, kept_runs: 2, deleted_bytes: 0 });
  });

  it('applies retentionDays but keeps un-finished runs', async () => {
    const dir = tempDir();
    const now = 100 * DAY;
    await seed(dir, 'old', terminal('old', now - 40 * DAY));
    await seed(dir, 'fresh', terminal('fresh', now - DAY));
    await seed(dir, 'active', [
      { type: 'run.started', run_id: 'active', data: {}, ts: now - 60 * DAY },
    ]);

    const result = await pruneTrace(dir, { retentionDays: 30, now });

    expect(result.deleted_runs).toBe(1);
    expect(result.kept_runs).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['active.jsonl', 'fresh.jsonl']);
  });

  it('applies maxRuns keeping the newest candidates', async () => {
    const dir = tempDir();
    await seed(dir, 'a', terminal('a', 10));
    await seed(dir, 'b', terminal('b', 20));
    await seed(dir, 'c', terminal('c', 30));

    const result = await pruneTrace(dir, { maxRuns: 2 });

    expect(result.deleted_runs).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['b.jsonl', 'c.jsonl']);
  });

  it('applies maxBytes from the oldest candidate', async () => {
    const dir = tempDir();
    const oldPath = await seed(dir, 'old', terminal('old', 10));
    const newPath = await seed(dir, 'new', terminal('new', 20));
    const oldSize = (await stat(oldPath)).size;
    const newSize = (await stat(newPath)).size;

    const result = await pruneTrace(dir, { maxBytes: newSize + 1 });

    expect(result.deleted_runs).toBe(1);
    expect(result.deleted_bytes).toBe(oldSize);
    expect(await readdir(dir)).toEqual(['new.jsonl']);
  });

  it('uses RunStore status to protect running/interrupted runs even with terminal events', async () => {
    const dir = tempDir();
    const store = new MemoryRunStore();
    await seed(dir, 'done', terminal('done', 10));
    await seed(dir, 'running', terminal('running', 20));
    await seed(dir, 'interrupted', terminal('interrupted', 30));
    await store.save(checkpoint('done', 'completed'));
    await store.save(checkpoint('running', 'running'));
    await store.save(checkpoint('interrupted', 'interrupted'));

    const result = await pruneTrace(dir, { runStore: store, maxRuns: 0 });

    expect(result.deleted_runs).toBe(1);
    expect(result.kept_runs).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['interrupted.jsonl', 'running.jsonl']);
  });

  it('returns zeros for a missing directory', async () => {
    expect(await pruneTrace(join(tempDir(), 'missing'))).toEqual({
      deleted_runs: 0,
      kept_runs: 0,
      deleted_bytes: 0,
    });
  });
});
