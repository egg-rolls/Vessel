import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/index';
import { MemoryEventStream } from '../src/events/index';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { SessionEventLog } from '../src/session/session-event-log';
import { SQLiteSessionBackend } from '../src/session/sqlite-backend';
import type { LLMProvider, Message } from '../src/types/provider';
import type { RunCheckpoint, RunStore } from '../src/types/run-store';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-sqlite-derived-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}),
      ),
  );
});

/** 只写一次 running checkpoint（模拟崩溃） */
class RunningOnlyRunStore implements RunStore {
  private checkpoint?: RunCheckpoint;
  async save(checkpoint: RunCheckpoint): Promise<void> {
    if (checkpoint.status === 'running') this.checkpoint = structuredClone(checkpoint);
  }
  async load(runId: string): Promise<RunCheckpoint | null> {
    return this.checkpoint?.run_id === runId ? structuredClone(this.checkpoint) : null;
  }
  async list(): Promise<RunCheckpoint[]> {
    return this.checkpoint ? [structuredClone(this.checkpoint)] : [];
  }
  async delete(): Promise<void> {
    this.checkpoint = undefined;
  }
}

describe('SQLiteSessionBackend.derived_upto_seq（0.18 P1）', () => {
  it('save/load 持久化 derived_upto_seq', async () => {
    const backend = new SQLiteSessionBackend(':memory:');
    try {
      await backend.save({
        run_id: 'run-1',
        session_id: 's1',
        messages: [{ role: 'user', content: 'hi' }],
        started_at: 1,
        status: 'completed',
        derived_upto_seq: 7,
      });
      expect((await backend.load('s1'))?.derived_upto_seq).toBe(7);
    } finally {
      backend.close();
    }
  });

  it('旧库没有该列时初始化补列，旧行读出 undefined', async () => {
    const dir = await tempDir();
    const path = join(dir, 'sessions.db');
    const legacy = new Database(path);
    legacy.run(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, messages TEXT NOT NULL,
        started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL,
        usage TEXT, error TEXT
      )
    `);
    legacy
      .prepare(
        `INSERT INTO sessions (session_id, run_id, messages, started_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('old', 'run-old', JSON.stringify([{ role: 'user', content: 'old' }]), 1, 'completed');
    legacy.close();

    const backend = new SQLiteSessionBackend(path);
    try {
      const state = await backend.load('old');
      expect(state?.messages).toHaveLength(1);
      expect(state?.derived_upto_seq).toBeUndefined();
      if (!state) throw new Error('expected legacy session');
      // 新写入带派生游标
      await backend.save({ ...state, derived_upto_seq: 3 });
      expect((await backend.load('old'))?.derived_upto_seq).toBe(3);
    } finally {
      backend.close();
    }
  });

  it('sqlite + 崩溃后 resume 仍能补齐工具轮（增量只读 seq > derived）', async () => {
    const dir = await tempDir();
    const backend = new SQLiteSessionBackend(join(dir, 'sessions.db'));
    const log = new SessionEventLog({ dir: join(dir, 'sessions'), durable: false });
    const store = new RunningOnlyRunStore();
    try {
      // run 开始时的缓存：user 消息；derived 覆盖到 seq 2（run.started + user.message）
      await backend.save({
        run_id: 'run-crash',
        session_id: 's1',
        messages: [{ role: 'user', content: 'go' }],
        started_at: 1,
        status: 'running',
        derived_upto_seq: 2,
      });
      await store.save({
        run_id: 'run-crash',
        session_id: 's1',
        status: 'running',
        messages: [],
        created_at: 1,
        updated_at: 2,
      });

      // seq 1/2 已被 session 缓存覆盖（derived=2）
      await log.append({
        session_id: 's1',
        run_id: 'run-crash',
        type: 'run.started',
        ts: 1,
        data: { run_id: 'run-crash', session_id: 's1', input: 'go' },
      });
      await log.append({
        session_id: 's1',
        run_id: 'run-crash',
        type: 'user.message',
        ts: 2,
        data: {
          run_id: 'run-crash',
          session_id: 's1',
          message: { role: 'user', content: 'go' },
        },
      });
      // 崩溃前已经落盘的事件：seq 3/4 是工具轮增量
      await log.append({
        session_id: 's1',
        run_id: 'run-crash',
        type: 'llm.response',
        ts: 3,
        data: {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
          ],
        },
      });
      await log.append({
        session_id: 's1',
        run_id: 'run-crash',
        type: 'tool.call.completed',
        ts: 4,
        data: { tool_call_id: 'call-1', tool_name: 'echo', result: 'tool-result' },
      });

      const seen: Message[][] = [];
      const provider: LLMProvider = {
        async chat(req) {
          seen.push(req.messages.map((message) => ({ ...message })));
          return { content: 'resumed', finish_reason: 'stop' };
        },
      };
      const runtime = await AgentRuntime.create({
        provider,
        model: 'test-model',
        context: new MemoryContextManager(),
        events: new MemoryEventStream(),
        limits: { requestLimit: 10, toolCallsLimit: 5 },
        termination: { maxIterations: 10 },
        pluginHost: new MemoryPluginHost(),
        session: backend,
        runStore: store,
        eventLog: log,
      });

      await expect(runtime.resume('run-crash')).resolves.toBe('resumed');
      expect(seen[0]?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
      expect(seen[0]?.[2]).toMatchObject({ role: 'tool', content: 'tool-result' });
      expect((await backend.load('s1'))?.derived_upto_seq ?? 0).toBeGreaterThan(2);
      await runtime.dispose();
    } finally {
      await log.close();
      backend.close();
    }
  });
});
