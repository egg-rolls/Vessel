import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/index.js';
import { MemoryEventStream } from '../src/events/index.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { MemoryPluginHost } from '../src/runtime/plugin-host.js';
import { FileSessionBackend } from '../src/session/file-backend.js';
import { FileRunStore } from '../src/session/run-store.js';
import { SessionEventLog } from '../src/session/session-event-log.js';
import type { LLMProvider, Message } from '../src/types/provider.js';
import type { RunCheckpoint, RunStore } from '../src/types/run-store.js';
import type { RunState, SessionBackend, SessionInfo } from '../src/types/session.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-resume-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 模拟崩溃：只保留 running checkpoint，终态写入被丢弃 */
class RunningOnlyRunStore implements RunStore {
  constructor(private readonly inner: FileRunStore) {}
  save(checkpoint: RunCheckpoint): Promise<void> {
    return checkpoint.status === 'running' ? this.inner.save(checkpoint) : Promise.resolve();
  }
  load(runId: string): Promise<RunCheckpoint | null> {
    return this.inner.load(runId);
  }
  list(opts?: Parameters<RunStore['list']>[0]): Promise<RunCheckpoint[]> {
    return this.inner.list(opts);
  }
  delete(runId: string): Promise<void> {
    return this.inner.delete(runId);
  }
  close(): Promise<void> {
    return this.inner.close?.() ?? Promise.resolve();
  }
}

/** 模拟崩溃：只保留 run 开始那次 session 快照 */
class FirstSaveOnlySession implements SessionBackend {
  private saves = 0;
  constructor(private readonly inner: FileSessionBackend) {}
  async save(state: RunState): Promise<void> {
    if (this.saves === 0) await this.inner.save(state);
    this.saves += 1;
  }
  load(sessionId: string): Promise<RunState | null> {
    return this.inner.load(sessionId);
  }
  delete(sessionId: string): Promise<void> {
    return this.inner.delete(sessionId);
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }
  listRich(): Promise<SessionInfo[]> {
    return this.inner.listRich();
  }
}

function toolCallProvider(): LLMProvider {
  let calls = 0;
  return {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'echo', arguments: '{"x":1}' },
            },
          ],
        };
      }
      throw new Error('simulated crash');
    },
  };
}

describe('resume 以 session + 事件日志为准（0.18 P0）', () => {
  it('工具轮中间崩溃后 resume 不丢工具结果', async () => {
    const root = await tempDir();
    const sessionsDir = join(root, 'sessions');
    const runsDir = join(root, 'runs');

    const sessionBackend = new FirstSaveOnlySession(new FileSessionBackend(sessionsDir));
    const store = new RunningOnlyRunStore(new FileRunStore({ dir: runsDir }));
    const eventLog = new SessionEventLog({ dir: sessionsDir, durable: false });

    const pluginHost = new MemoryPluginHost();
    pluginHost.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'tool-result',
    });

    const crashRuntime = await AgentRuntime.create({
      provider: toolCallProvider(),
      model: 'test-model',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      pluginHost,
      session: sessionBackend,
      runStore: store,
      eventLog,
    });

    await expect(crashRuntime.run('go', 'session-1', { runId: 'run-crash' })).rejects.toThrow(
      'simulated crash',
    );

    // 崩溃后：checkpoint 无 messages，但有事件游标；session 只有 run 开始快照。
    const checkpoint = await store.load('run-crash');
    expect(checkpoint?.status).toBe('running');
    expect(checkpoint?.messages).toEqual([]);
    expect(typeof checkpoint?.event_cursor).toBe('number');
    expect(checkpoint?.event_cursor ?? 0).toBeGreaterThan(0);

    const before = await sessionBackend.load('session-1');
    expect(before?.messages.map((message) => message.content)).toEqual(['go']);
    expect(typeof before?.derived_upto_seq).toBe('number');

    const tail = await eventLog.read('session-1', {
      sinceSeq: before?.derived_upto_seq ?? 0,
    });
    expect(tail.some((event) => event.type === 'llm.response')).toBe(true);
    expect(tail.some((event) => event.type === 'tool.call.completed')).toBe(true);

    // 新进程：同目录新实例，resume 必须从事件日志补齐工具轮。
    const seen: Message[][] = [];
    const resumeProvider: LLMProvider = {
      async chat(req) {
        seen.push(req.messages.map((message) => ({ ...message })));
        return { content: 'resumed-done', finish_reason: 'stop' };
      },
    };
    const resumedLog = new SessionEventLog({ dir: sessionsDir, durable: false });
    const resumeRuntime = await AgentRuntime.create({
      provider: resumeProvider,
      model: 'test-model',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: { requestLimit: 10, toolCallsLimit: 5 },
      termination: { maxIterations: 10 },
      pluginHost,
      session: new FileSessionBackend(sessionsDir),
      runStore: store,
      eventLog: resumedLog,
    });

    await expect(resumeRuntime.resume('run-crash')).resolves.toBe('resumed-done');

    const request = seen[0] ?? [];
    expect(request.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(request[1]?.tool_calls?.[0]?.id).toBe('call-1');
    expect(request[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'tool-result',
    });

    const events = await resumedLog.read('session-1');
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    // 顺序不变量：seq 连续、run_id 正确
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );

    await eventLog.close();
    await resumedLog.close();
    await crashRuntime.dispose();
    await resumeRuntime.dispose();
  });
});
