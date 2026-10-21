import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '../../packages/core/src/index';
import {
  type ConnectRunStart,
  ConnectRunTimeoutError,
  waitForConnectedRun,
} from '../connect-run-wait';

function completedEvent(runId: string, output: string): RunEvent {
  return {
    type: 'run.completed',
    run_id: runId,
    data: { run_id: runId, session_id: 's1', output },
    ts: Date.now(),
  };
}

const jobStart: ConnectRunStart = { kind: 'job', jobId: 'job-1' };

describe('waitForConnectedRun（0.18 连接模式终态等待）', () => {
  it('run.started + run.completed 事件路径返回完整 output', async () => {
    const events = new MemoryEventStream();
    const pending = waitForConnectedRun({
      events,
      prompt: 'hello',
      sessionId: 's1',
      timeoutMs: 1000,
      pollIntervalMs: 50,
      start: async () => {
        queueMicrotask(() => {
          events.publish({
            type: 'run.started',
            run_id: 'core-1',
            data: { run_id: 'core-1', session_id: 's1', input: 'hello' },
            ts: Date.now(),
          });
          events.publish(completedEvent('core-1', 'event-output'));
        });
        return jobStart;
      },
      getRun: async () => ({ run: { core_run_id: 'core-1', status: 'running' } }),
    });
    await expect(pending).resolves.toBe('event-output');
  });

  it('runs.get 可用时不误收同 session+prompt 的其它 run 终态', async () => {
    const events = new MemoryEventStream();
    const pending = waitForConnectedRun({
      events,
      prompt: 'same prompt',
      sessionId: 's1',
      timeoutMs: 150,
      pollIntervalMs: 10,
      start: async () => {
        queueMicrotask(() => {
          // 另一个同 prompt 的 run（同为 session s1）完成
          events.publish({
            type: 'run.started',
            run_id: 'core-other',
            data: { session_id: 's1', input: 'same prompt' },
            ts: Date.now(),
          });
          events.publish(completedEvent('core-other', 'wrong-output'));
        });
        return { kind: 'job', jobId: 'job-1' };
      },
      // 本 job 仍在运行
      getRun: async () => ({
        run: { run_id: 'job-1', core_run_id: 'core-mine', status: 'running' },
      }),
    });
    // 必须超时，而不是返回 wrong-output
    await expect(pending).rejects.toBeInstanceOf(ConnectRunTimeoutError);
  });

  it('终态事件不投递时靠 runs.get({run}) 轮询兜底', async () => {
    const events = new MemoryEventStream();
    let calls = 0;
    const result = await waitForConnectedRun({
      events,
      prompt: 'hello',
      sessionId: 's1',
      timeoutMs: 1000,
      pollIntervalMs: 10,
      start: async () => jobStart,
      getRun: async () => {
        calls += 1;
        return {
          // 真实 gateway 返回 `{run:{...}}`；旧实现直接读顶层会永远读不到。
          run: {
            run_id: 'job-1',
            core_run_id: 'core-1',
            status: calls >= 2 ? 'completed' : 'running',
            output: 'poll-output',
          },
        };
      },
    });
    expect(result).toBe('poll-output');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('runs.get 确认 core_run_id 后仍能接住终态事件', async () => {
    const events = new MemoryEventStream();
    const pending = waitForConnectedRun({
      events,
      prompt: 'hello',
      sessionId: 's1',
      timeoutMs: 1000,
      pollIntervalMs: 10,
      start: async () => {
        queueMicrotask(() => events.publish(completedEvent('core-1', 'x')));
        return jobStart;
      },
      getRun: async () => ({
        run: { run_id: 'job-1', core_run_id: 'core-1', status: 'running' },
      }),
    });
    await expect(pending).resolves.toBe('x');
  });

  it('runs.get 不可用且无终态事件 → 显式超时（不永久挂起）', async () => {
    const events = new MemoryEventStream();
    await expect(
      waitForConnectedRun({
        events,
        prompt: 'hello',
        sessionId: 's1',
        timeoutMs: 30,
        pollIntervalMs: 10,
        start: async () => jobStart,
        getRun: async () => {
          throw new Error('runs.get unavailable');
        },
      }),
    ).rejects.toBeInstanceOf(ConnectRunTimeoutError);
  });

  it('旧 gateway 直接返回文本时原样返回', async () => {
    const events = new MemoryEventStream();
    await expect(
      waitForConnectedRun({
        events,
        prompt: 'hello',
        sessionId: 's1',
        timeoutMs: 100,
        start: async () => ({ kind: 'legacy', text: 'legacy-output' }),
        getRun: async () => undefined,
      }),
    ).resolves.toBe('legacy-output');
  });
});
