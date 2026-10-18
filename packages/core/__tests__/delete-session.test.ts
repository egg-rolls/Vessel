import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryEventStream } from '../src/events/event-stream';
import type { RunCheckpoint, RunState } from '../src/index';
import {
  deleteSessionData,
  MemoryRunStore,
  MemorySessionBackend,
  SessionDeleteConflictError,
} from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-delete-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

function checkpoint(runId: string, status: RunCheckpoint['status']): RunCheckpoint {
  return {
    run_id: runId,
    session_id: 's1',
    status,
    messages: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function state(): RunState {
  return {
    run_id: 'r1',
    session_id: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    started_at: Date.now(),
    status: 'completed',
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('deleteSessionData (0.5 A-4 §11.3)', () => {
  it('rejects with conflict when a run is running or interrupted', async () => {
    for (const status of ['running', 'interrupted'] as const) {
      const session = new MemorySessionBackend();
      const runStore = new MemoryRunStore();
      await session.save(state());
      await runStore.save(checkpoint('r1', status));

      const promise = deleteSessionData('s1', { session, runStore });
      await expect(promise).rejects.toBeInstanceOf(SessionDeleteConflictError);

      expect(await session.load('s1')).not.toBeNull();
      expect(await runStore.list()).toHaveLength(1);
    }
  });

  it('deletes the snapshot plus runs and trace files, returning counts', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'r1.jsonl'), '', 'utf8');
    await writeFile(join(dir, 'r2.jsonl'), '', 'utf8');
    const session = new MemorySessionBackend();
    const runStore = new MemoryRunStore();
    const events = new MemoryEventStream();
    await session.save(state());
    await runStore.save(checkpoint('r1', 'completed'));
    await runStore.save(checkpoint('r2', 'failed'));

    const result = await deleteSessionData('s1', {
      session,
      runStore,
      traceDir: dir,
      events,
      tenantId: 'acme',
    });

    expect(result).toEqual({ runs_deleted: 2, events_deleted: 2 });
    expect(await session.load('s1')).toBeNull();
    expect(await runStore.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);

    const deleted = events.getHistory().find((e) => e.type === 'session.deleted');
    expect(deleted?.tenant_id).toBe('acme');
    expect(deleted?.data).toMatchObject({ session_id: 's1', runs_deleted: 2, events_deleted: 2 });
  });

  it('deletes only the snapshot when no RunStore is provided', async () => {
    const session = new MemorySessionBackend();
    await session.save(state());

    expect(await deleteSessionData('s1', { session })).toEqual({
      runs_deleted: 0,
      events_deleted: 0,
    });
    expect(await session.load('s1')).toBeNull();
  });

  it('validates the session id', async () => {
    await expect(deleteSessionData('', { session: new MemorySessionBackend() })).rejects.toThrow(
      /invalid_session_id/,
    );
  });
});
