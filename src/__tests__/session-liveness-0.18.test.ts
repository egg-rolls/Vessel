/**
 * 0.18 session liveness 对账。
 *
 * 守四类会静默失败的故障：
 * 1. 硬崩留下的 running session（死 pid 锁）永远显示运行中、事件无终态；
 * 2. 每次启动都 sweep，重复对账不能追加第二条终态事件；
 * 3. 锁被活进程持有（resume 只持 run 锁）时不能误标中断；
 * 4. 终态事件已落、session 状态未写的半崩不能重复追加事件。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRunStore,
  FileSessionBackend,
  noopLogger,
  type RunState,
  SessionEventLog,
  sessionIndexFilePath,
} from '../../packages/core/src/index';
import { reconcileSession, type SessionLivenessContext } from '../session-liveness';
import { acquireSessionLock, resetHeldSessionLocksForTest } from '../session-lock';

const dirs: string[] = [];
const logs: SessionEventLog[] = [];

async function tempTenant(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-session-liveness-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetHeldSessionLocksForTest();
  await Promise.all(logs.splice(0).map((log) => log.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  tenantDir: string;
  sessionsDir: string;
  session: FileSessionBackend;
  eventLog: SessionEventLog;
  runStore: FileRunStore;
  nowMs: number;
  ctx: SessionLivenessContext;
}

async function harness(isPidAlive: (pid: number) => boolean): Promise<Harness> {
  const tenantDir = await tempTenant();
  const sessionsDir = join(tenantDir, 'sessions');
  const session = new FileSessionBackend(sessionsDir);
  const eventLog = new SessionEventLog({ dir: sessionsDir, durable: false });
  logs.push(eventLog);
  const runStore = new FileRunStore({ dir: join(tenantDir, 'runs') });
  const nowMs = 5_000;
  const ctx: SessionLivenessContext = {
    tenantDir,
    session,
    eventLog,
    runStore,
    logger: noopLogger,
    now: () => nowMs,
    hostname: 'test-host',
    isPidAlive,
  };
  return { tenantDir, sessionsDir, session, eventLog, runStore, nowMs, ctx };
}

function runningState(sessionId: string, runId: string, startedAt: number): RunState {
  return {
    run_id: runId,
    session_id: sessionId,
    messages: [{ role: 'user', content: 'hello' }],
    started_at: startedAt,
    updated_at: startedAt,
    status: 'running',
  };
}

describe('session liveness', () => {
  it('stale running session with a dead owner is not left running and gets exactly one process_lost terminal event', async () => {
    const h = await harness((pid) => pid !== 999_999);
    const sessionId = 'sess-stale';
    const runId = 'run-stale';
    await h.session.save(runningState(sessionId, runId, 1_000));
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_001,
      type: 'user.message',
      data: { message: { role: 'user', content: 'hello' } },
    });
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_002,
      type: 'llm.request',
      data: { run_id: runId },
    });
    await h.runStore.save({
      run_id: runId,
      session_id: sessionId,
      status: 'running',
      messages: [],
      created_at: 1_000,
      updated_at: 1_000,
    });

    // 硬崩留下的锁：死 pid，且永不释放。
    await acquireSessionLock({
      tenantDir: h.tenantDir,
      kind: 'session',
      id: sessionId,
      pid: 999_999,
      hostname: 'test-host',
    });

    const outcome = await reconcileSession(sessionId, h.ctx);
    expect(outcome).toBe('repaired');

    const repaired = await h.session.load(sessionId);
    expect(repaired?.status).toBe('failed');
    expect(repaired?.error).toBe('run lost: owning process exited before completion');

    const events = await h.eventLog.read(sessionId);
    const terminal = events.filter(
      (event) => event.run_id === runId && event.type === 'run.failed',
    );
    expect(terminal.length).toBe(1);
    const payload = terminal[0]?.data as { error_code?: string } | undefined;
    expect(payload?.error_code).toBe('process_lost');

    const lastSeq = events[events.length - 1]?.seq;
    expect(lastSeq).toBe(3);
    expect(repaired?.derived_upto_seq).toBe(lastSeq);

    const index = JSON.parse(
      await readFile(sessionIndexFilePath(h.sessionsDir, sessionId), 'utf8'),
    ) as { status?: string; derived_upto_seq?: number; event_count?: number };
    expect(index.status).toBe('failed');
    expect(index.derived_upto_seq).toBe(lastSeq);
    expect(index.event_count).toBe(lastSeq);

    const checkpoint = await h.runStore.load(runId);
    expect(checkpoint?.status).toBe('interrupted');
    expect(checkpoint?.error_envelope?.error_code).toBe('process_lost');
    expect(checkpoint?.event_cursor).toBe(lastSeq);
  });

  it('a second reconcile does not append another terminal event', async () => {
    const h = await harness((pid) => pid !== 999_999);
    const sessionId = 'sess-twice';
    const runId = 'run-twice';
    await h.session.save(runningState(sessionId, runId, 1_000));
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_001,
      type: 'user.message',
      data: {},
    });
    await acquireSessionLock({
      tenantDir: h.tenantDir,
      kind: 'session',
      id: sessionId,
      pid: 999_999,
      hostname: 'test-host',
    });

    expect(await reconcileSession(sessionId, h.ctx)).toBe('repaired');
    const afterFirst = await h.eventLog.read(sessionId);
    expect(afterFirst.filter((event) => event.type === 'run.failed').length).toBe(1);

    expect(await reconcileSession(sessionId, h.ctx)).toBe('ok');
    const afterSecond = await h.eventLog.read(sessionId);
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(afterSecond.filter((event) => event.type === 'run.failed').length).toBe(1);
  });

  it('a live owner is not marked interrupted', async () => {
    const h = await harness(() => true);
    const sessionId = 'sess-live';
    const runId = 'run-live';
    await h.session.save(runningState(sessionId, runId, 1_000));
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_001,
      type: 'user.message',
      data: {},
    });

    // 活进程持锁（同进程默认 pid）；不释放。
    await acquireSessionLock({
      tenantDir: h.tenantDir,
      kind: 'session',
      id: sessionId,
      hostname: 'test-host',
    });

    expect(await reconcileSession(sessionId, h.ctx)).toBe('live');
    const state = await h.session.load(sessionId);
    expect(state?.status).toBe('running');
    const events = await h.eventLog.read(sessionId);
    expect(events.filter((event) => event.type === 'run.failed').length).toBe(0);
  });

  it('a terminal event without the status write does not get a duplicate event', async () => {
    const h = await harness(() => true);
    const sessionId = 'sess-half';
    const runId = 'run-half';
    await h.session.save(runningState(sessionId, runId, 1_000));
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_001,
      type: 'user.message',
      data: {},
    });
    await h.eventLog.append({
      session_id: sessionId,
      run_id: runId,
      ts: 1_002,
      type: 'run.failed',
      data: { run_id: runId, error: 'already failed', error_code: 'process_lost' },
    });

    expect(await reconcileSession(sessionId, h.ctx)).toBe('repaired');

    const events = await h.eventLog.read(sessionId);
    const terminal = events.filter(
      (event) => event.run_id === runId && event.type === 'run.failed',
    );
    expect(terminal.length).toBe(1);
    const lastSeq = events[events.length - 1]?.seq ?? 0;

    const repaired = await h.session.load(sessionId);
    expect(repaired?.status).toBe('failed');
    expect(repaired?.derived_upto_seq).toBe(lastSeq);

    const index = JSON.parse(
      await readFile(sessionIndexFilePath(h.sessionsDir, sessionId), 'utf8'),
    ) as { status?: string; derived_upto_seq?: number };
    expect(index.status).toBe('failed');
    expect(index.derived_upto_seq).toBe(lastSeq);
  });
});
