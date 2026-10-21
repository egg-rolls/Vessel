import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream } from '../src/events/index.js';
import { deleteSessionData } from '../src/session/delete-session.js';
import { FileSessionBackend } from '../src/session/file-backend.js';
import { FileRunStore } from '../src/session/run-store.js';
import { SessionEventLog } from '../src/session/session-event-log.js';
import { sessionDirPath } from '../src/tenant/tenant-paths.js';
import type { RunCheckpoint } from '../src/types/run-store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-delete-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function checkpoint(sessionId: string, runId: string): RunCheckpoint {
  return {
    run_id: runId,
    session_id: sessionId,
    status: 'completed',
    messages: [],
    created_at: 1,
    updated_at: 2,
  };
}

describe('deleteSessionData 一致性（0.18 P0）', () => {
  it('删除 session = 删除 sessions/<id>/、runs、遗留 events jsonl；不再新增孤儿文件', async () => {
    const root = await tempDir();
    const sessionsDir = join(root, 'sessions');
    const runsDir = join(root, 'runs');
    const traceDir = join(root, 'events');
    const sessionId = 's/one';
    const runId = 'run-1';

    const session = new FileSessionBackend(sessionsDir);
    await session.save({
      run_id: runId,
      session_id: sessionId,
      messages: [{ role: 'user', content: 'hello' }],
      started_at: 1,
      status: 'completed',
    });
    const runStore = new FileRunStore({ dir: runsDir });
    await runStore.save(checkpoint(sessionId, runId));

    const eventLog = new SessionEventLog({ dir: sessionsDir, durable: false });
    await eventLog.append({
      session_id: sessionId,
      run_id: runId,
      type: 'user.message',
      ts: 1,
      data: { message: { role: 'user', content: 'hello' } },
    });
    await eventLog.updateIndex(sessionId, { title: 'hello' });

    // 0.5 遗留：sessionId 被当成 run_id 写出的孤儿 trace
    await mkdir(traceDir, { recursive: true });
    await writeFile(join(traceDir, `${encodeURIComponent(sessionId)}.jsonl`), '', 'utf8');

    const events = new MemoryEventStream();
    let publishCount = 0;
    events.subscribe(() => {
      publishCount += 1;
    });

    const result = await deleteSessionData(sessionId, {
      session,
      runStore,
      traceDir,
      events,
      eventLog,
    });

    expect(result).toEqual({ sessions_deleted: 1, runs_deleted: 1, events_deleted: 1 });
    // 墓碑仍作为实时事件发布（不落成新文件）
    expect(publishCount).toBe(1);
    expect(await readdir(runsDir)).toEqual([]);
    await expect(stat(sessionDirPath(sessionsDir, sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      stat(join(traceDir, `${encodeURIComponent(sessionId)}.jsonl`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await session.load(sessionId)).toBeNull();
    expect(await eventLog.deleteSession(sessionId)).toBe(false);
    await eventLog.close();
  });

  it('不存在的 session 删除返回 0（不再恒为 1）', async () => {
    const root = await tempDir();
    const sessionsDir = join(root, 'sessions');
    const session = new FileSessionBackend(sessionsDir);
    const runStore = new FileRunStore({ dir: join(root, 'runs') });
    const eventLog = new SessionEventLog({ dir: sessionsDir, durable: false });
    try {
      const result = await deleteSessionData('missing', { session, runStore, eventLog });
      expect(result).toEqual({ sessions_deleted: 0, runs_deleted: 0, events_deleted: 0 });
    } finally {
      await eventLog.close();
    }
  });
});
