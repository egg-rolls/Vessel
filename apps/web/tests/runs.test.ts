import { describe, expect, test } from 'bun:test';
import type { DurableRunSummary, RunStatus } from '../src/gateway/types';
import {
  filterDurableRuns,
  filterLiveRuns,
  isAlreadyResumedError,
  isCancellableRun,
  isResumableRun,
  runDurationMs,
  sortDurableRuns,
  sortLiveRuns,
  takeRuns,
} from '../src/state/runs';

function run(id: string, overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    run_id: id,
    session_id: 's1',
    status: 'running',
    ...overrides,
  };
}

function durable(id: string, overrides: Partial<DurableRunSummary> = {}): DurableRunSummary {
  return {
    run_id: id,
    session_id: 's1',
    status: 'interrupted',
    updated_at: 1,
    ...overrides,
  };
}

describe('run predicates', () => {
  test('cancellable covers queued and running only', () => {
    expect(isCancellableRun('queued')).toBe(true);
    expect(isCancellableRun('running')).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
      expect(isCancellableRun(status)).toBe(false);
    }
  });

  test('resumable covers interrupted, failed and pending', () => {
    for (const status of ['interrupted', 'failed', 'pending']) {
      expect(isResumableRun(status)).toBe(true);
    }
    for (const status of ['running', 'completed', 'cancelled']) {
      expect(isResumableRun(status)).toBe(false);
    }
  });

  test('duration is only defined for terminal runs', () => {
    expect(runDurationMs({ started_at: 10, completed_at: 25 })).toBe(15);
    expect(runDurationMs({ started_at: 10 })).toBeUndefined();
    expect(runDurationMs({ started_at: 25, completed_at: 10 })).toBe(0);
  });
});

describe('sorting', () => {
  test('live runs sort by started_at desc, then id desc', () => {
    const list = [
      run('a', { started_at: 1 }),
      run('c', { started_at: 5 }),
      run('b', { started_at: 5 }),
      run('d'),
    ];
    expect(sortLiveRuns(list).map((entry) => entry.run_id)).toEqual(['c', 'b', 'a', 'd']);
  });

  test('durable runs sort by updated_at desc', () => {
    const list = [durable('a', { updated_at: 1 }), durable('b', { updated_at: 9 })];
    expect(sortDurableRuns(list).map((entry) => entry.run_id)).toEqual(['b', 'a']);
  });
});

describe('filters', () => {
  const live = [
    run('r1', { status: 'running', session_id: 's1', output: 'ok' }),
    run('r2', { status: 'failed', session_id: 's2', error: 'boom' }),
    run('r3', { status: 'queued', session_id: 's1' }),
  ];

  test('filters live by status, session and text', () => {
    expect(filterLiveRuns(live, { status: 'running' }).map((r) => r.run_id)).toEqual(['r1']);
    expect(filterLiveRuns(live, { sessionId: 's1' }).map((r) => r.run_id)).toEqual(['r1', 'r3']);
    expect(filterLiveRuns(live, { query: 'BOOM' }).map((r) => r.run_id)).toEqual(['r2']);
    expect(filterLiveRuns(live, { query: 'r3' }).map((r) => r.run_id)).toEqual(['r3']);
  });

  test('durable filters support interrupted', () => {
    const list = [durable('d1', { status: 'interrupted' }), durable('d2', { status: 'completed' })];
    expect(filterDurableRuns(list, { status: 'interrupted' }).map((r) => r.run_id)).toEqual(['d1']);
  });

  test('takeRuns windows without mutating', () => {
    const list = [1, 2, 3];
    expect(takeRuns(list, 2)).toEqual({ shown: [1, 2], hiddenCount: 1 });
    expect(takeRuns(list, 5)).toEqual({ shown: [1, 2, 3], hiddenCount: 0 });
    expect(list).toEqual([1, 2, 3]);
  });
});

describe('isAlreadyResumedError', () => {
  test('treats conflict/run_already_running as already resumed', () => {
    expect(isAlreadyResumedError(new Error('conflict: Run is already being resumed'))).toBe(true);
    expect(isAlreadyResumedError(Object.assign(new Error('x'), { code: 'conflict' }))).toBe(true);
    expect(isAlreadyResumedError(new Error('run_already_running'))).toBe(true);
  });

  test('does not swallow unrelated failures', () => {
    expect(isAlreadyResumedError(new Error('not_found: Run not found'))).toBe(false);
    expect(isAlreadyResumedError(new Error('network down'))).toBe(false);
  });
});
