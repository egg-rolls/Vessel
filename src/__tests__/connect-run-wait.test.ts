import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '../../packages/core/src/index';
import {
  type ConnectRunStart,
  ConnectRunTimeoutError,
  waitForConnectedResumeTerminal,
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

function resumedEvent(runId: string, sessionId: string): RunEvent {
  return {
    type: 'run.resumed',
    run_id: runId,
    data: { run_id: runId, session_id: sessionId },
    ts: Date.now(),
  };
}

function failedEvent(runId: string, code: string, message: string): RunEvent {
  return {
    type: 'run.failed',
    run_id: runId,
    data: { run_id: runId, session_id: 's1', error_code: code, error: message },
    ts: Date.now(),
  };
}

function cancelledEvent(runId: string): RunEvent {
  return {
    type: 'run.cancelled',
    run_id: runId,
    data: { run_id: runId, session_id: 's1' },
    ts: Date.now(),
  };
}

describe('waitForConnectedResumeTerminal（0.18 远程 resume 终态）', () => {
  it('runs.resume 只返回 queued 时不得提前返回空串——必须等 run.completed 输出', async () => {
    const events = new MemoryEventStream();
    let resumeCalls = 0;
    const pending = waitForConnectedResumeTerminal({
      events,
      runId: 'run-1',
      timeoutMs: 1000,
      pollIntervalMs: 50,
      resume: async () => {
        resumeCalls += 1;
        queueMicrotask(() => events.publish(completedEvent('run-1', 'full-output')));
        return { kind: 'queued', runId: 'run-1' };
      },
      getRun: async () => ({ run: { run_id: 'run-1', status: 'running' } }),
    });
    await expect(pending).resolves.toEqual({
      sessionId: 's1',
      output: 'full-output',
      outputSource: 'event',
    });
    expect(resumeCalls).toBe(1);
  });

  it('终态事件丢失时靠 runs.get 的 completed checkpoint 收口', async () => {
    const events = new MemoryEventStream();
    const startedAt = Date.now();
    const outcome = await waitForConnectedResumeTerminal({
      events,
      runId: 'run-1',
      sessionId: 'initial-session',
      timeoutMs: 2000,
      pollIntervalMs: 50,
      resume: async () => ({ kind: 'queued', runId: 'run-1' }),
      getRun: async () => ({
        run: { run_id: 'run-1', status: 'completed', session_id: 'checkpoint-session' },
      }),
    });
    expect(outcome).toEqual({
      sessionId: 'checkpoint-session',
      output: '',
      outputSource: 'checkpoint',
    });
    // 必须真的等过一个 poll 的 grace，而不是一看到 checkpoint completed 就返回。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it('受理瞬间 checkpoint 仍是 interrupted 时不得提前失败', async () => {
    const events = new MemoryEventStream();
    const pending = waitForConnectedResumeTerminal({
      events,
      runId: 'run-1',
      timeoutMs: 2000,
      pollIntervalMs: 50,
      resume: async () => {
        // resume 刚受理，checkpoint 还没翻成 running；稍后事件才到。
        setTimeout(() => {
          events.publish(resumedEvent('run-1', 's1'));
          events.publish(completedEvent('run-1', 'after-interrupt'));
        }, 120);
        return { kind: 'queued', runId: 'run-1' };
      },
      // 轮询一直读到受理前的 interrupted，也绝不能当终态早退。
      getRun: async () => ({ run: { run_id: 'run-1', status: 'interrupted' } }),
    });
    await expect(pending).resolves.toEqual({
      sessionId: 's1',
      output: 'after-interrupt',
      outputSource: 'event',
    });
  });

  it('同一 run 只调用一次 runs.resume——超时后也不重发', async () => {
    const events = new MemoryEventStream();
    let resumeCalls = 0;
    let timeoutError: unknown;
    try {
      await waitForConnectedResumeTerminal({
        events,
        runId: 'run-1',
        timeoutMs: 80,
        pollIntervalMs: 50,
        resume: async () => {
          resumeCalls += 1;
          return { kind: 'queued', runId: 'run-1' };
        },
        getRun: async () => ({ run: { run_id: 'run-1', status: 'running' } }),
      });
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toBeInstanceOf(ConnectRunTimeoutError);
    expect((timeoutError as Error).message).toContain('the remote run may still be running');
    expect(resumeCalls).toBe(1);
  });

  it('run.failed 的 error_code 与 run.cancelled 映射为稳定错误', async () => {
    const failedEvents = new MemoryEventStream();
    const failed = waitForConnectedResumeTerminal({
      events: failedEvents,
      runId: 'run-1',
      timeoutMs: 1000,
      pollIntervalMs: 50,
      resume: async () => {
        queueMicrotask(() => failedEvents.publish(failedEvent('run-1', 'provider_error', 'boom')));
        return { kind: 'queued', runId: 'run-1' };
      },
      getRun: async () => ({ run: { run_id: 'run-1', status: 'running' } }),
    });
    await expect(failed).rejects.toMatchObject({ code: 'provider_error', message: 'boom' });

    const cancelledEvents = new MemoryEventStream();
    const cancelled = waitForConnectedResumeTerminal({
      events: cancelledEvents,
      runId: 'run-1',
      timeoutMs: 1000,
      pollIntervalMs: 50,
      resume: async () => {
        queueMicrotask(() => cancelledEvents.publish(cancelledEvent('run-1')));
        return { kind: 'queued', runId: 'run-1' };
      },
      getRun: async () => ({ run: { run_id: 'run-1', status: 'running' } }),
    });
    await expect(cancelled).rejects.toMatchObject({ code: 'resume_cancelled' });
  });

  it('run.resumed 后又 interrupted：一个 poll grace 后 reject run_interrupted', async () => {
    const events = new MemoryEventStream();
    const startedAt = Date.now();
    let polls = 0;
    const pending = waitForConnectedResumeTerminal({
      events,
      runId: 'run-1',
      timeoutMs: 5000,
      pollIntervalMs: 50,
      resume: async () => {
        events.publish(resumedEvent('run-1', 's1'));
        return { kind: 'queued', runId: 'run-1' };
      },
      // 先真正跑过（running），再回到 interrupted，才算 resume 后被中断。
      getRun: async () => ({
        run: { run_id: 'run-1', status: polls++ === 0 ? 'running' : 'interrupted' },
      }),
    });
    await expect(pending).rejects.toMatchObject({ code: 'run_interrupted' });
    // 不能挂到 5s 超时。
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
