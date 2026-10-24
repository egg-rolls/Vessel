/**
 * 关闭顺序：成员轮必须在 tenant 共享 eventLog 关闭前收口。
 *
 * 故障形状：tenant drain 只看根 runtime；成员 run 仍在跑时 eventLog.close()，
 * 之后成员尾部事件 append 被拒 `session_event_log_closed`。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LLMProvider,
  type LogFields,
  type Logger,
  MemoryPluginHost,
  SessionEventLog,
} from '@vessel-agent/core';
import { createInProcessMemberRuntime } from '../src/runtime.js';
import { createAgentService } from '../src/service.js';
import type { MemberRuntimePort } from '../src/types.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-drain-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface LogEntry {
  message: string;
  fields?: LogFields;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const push = (message: string, fields?: LogFields) => {
    entries.push({ message, ...(fields !== undefined ? { fields } : {}) });
  };
  return { debug: () => {}, info: () => {}, warn: push, error: push };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AgentService.drain', () => {
  it('interrupts the running member turn and never starts queued messages', async () => {
    const started = deferred();
    const gate = deferred();
    const calls: string[] = [];
    const runtime: MemberRuntimePort = {
      async spawn() {},
      async runTurn() {
        calls.push('run');
        started.resolve();
        await gate.promise;
        return { outcome: 'cancelled' };
      },
      cancel() {
        calls.push('cancel');
        gate.resolve();
      },
      dispose() {},
    };
    const service = createAgentService({
      tenantId: 'default',
      runtime,
      newId: () => 'm1',
    });
    const member = await service.new({ visibility: 'team' });
    await service.dispatch({ to: member.id, content: 'one' });
    await service.dispatch({ to: member.id, content: 'two' });
    await started.promise;

    const outcome = await service.drain({ timeoutMs: 1000 });

    expect(outcome).toBe('interrupted');
    expect(calls).toEqual(['run', 'cancel']);
  });

  it('flushes member events before the shared event log closes', async () => {
    const dir = await tempDir();
    const sessionsDir = join(dir, 'sessions');
    const logs: LogEntry[] = [];
    const logger = recordingLogger(logs);
    const eventLog = new SessionEventLog({ dir: sessionsDir, logger, durable: false });

    const started = deferred();
    const gate = deferred();
    const provider: LLMProvider = {
      async chat() {
        started.resolve();
        await gate.promise;
        return {
          content: 'ok',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
    const runtime = createInProcessMemberRuntime({
      providerFactory: () => provider,
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
      eventLog,
      logger,
    });
    const service = createAgentService({ tenantId: 'default', runtime, logger });
    const member = await service.new({ visibility: 'team' });
    const dispatched = service.dispatch({ to: member.id, content: 'hello' });
    await started.promise;

    const drainPromise = service.drain({ timeoutMs: 5000 });
    gate.resolve();
    const outcome = await drainPromise;
    await eventLog.close();
    await dispatched;

    expect(logs.filter((entry) => entry.message === 'session event log write failed')).toHaveLength(
      0,
    );
    expect(outcome).toBe('interrupted');
  });
});
