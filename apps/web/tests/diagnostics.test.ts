import { describe, expect, test } from 'bun:test';
import type { RunEvent, RuntimeHealth } from '../src/gateway/types';
import {
  DIAGNOSTIC_ERROR_TYPES,
  diagnosticCategoryOf,
  diagnosticEntries,
  includesDiagnostics,
  runtimeQueueRows,
} from '../src/state/diagnostics';

function event(type: string, data: Record<string, unknown> = {}, ts = 1): RunEvent {
  return { type, run_id: 'r1', data, ts };
}

describe('diagnosticEntries', () => {
  test('hides process/plugin errors unless errorLevel is all or showProcessErrors', () => {
    const events = [
      event('run.failed', { error: 'run broke' }, 1),
      event('process.error', { error: 'process broke' }, 2),
    ];
    const user = diagnosticEntries(events, { errorLevel: 'user', showProcessErrors: false });
    expect(user.map((entry) => entry.type)).toEqual(['run.failed']);

    const all = diagnosticEntries(events, { errorLevel: 'all', showProcessErrors: false });
    expect(all.map((entry) => entry.type)).toEqual(['process.error', 'run.failed']);

    const process = diagnosticEntries(events, {
      errorLevel: 'user',
      showProcessErrors: true,
    });
    expect(process.map((entry) => entry.type)).toEqual(['process.error', 'run.failed']);
  });

  test('covers the process/shutdown/hook/plugin event names', () => {
    for (const type of DIAGNOSTIC_ERROR_TYPES) {
      expect(diagnosticCategoryOf(type)).not.toBe('run');
    }
    expect(diagnosticCategoryOf('process.error')).toBe('process');
    expect(diagnosticCategoryOf('shutdown.failed')).toBe('shutdown');
    expect(diagnosticCategoryOf('hook.error')).toBe('hook');
    expect(diagnosticCategoryOf('plugin.failed')).toBe('plugin');
    expect(includesDiagnostics({ errorLevel: 'user', showProcessErrors: true })).toBe(true);
  });

  test('keeps only display fields and sorts newest first', () => {
    const entries = diagnosticEntries(
      [
        event('run.failed', { error: 'old', stack: 'SECRET STACK' }, 1),
        event(
          'run.failed',
          { error: 'new', error_code: 'provider_timeout', phase: 'llm', retryable: true },
          2,
        ),
      ],
      { errorLevel: 'all', showProcessErrors: false },
    );
    expect(entries[0]).toMatchObject({
      message: 'new',
      errorCode: 'provider_timeout',
      phase: 'llm',
      retryable: true,
    });
    expect(entries[0]).not.toHaveProperty('stack');
    expect(entries[1]?.message).toBe('old');
  });
});

describe('runtimeQueueRows', () => {
  test('puts queued runs before running and keeps wait_reason', () => {
    const runtime: RuntimeHealth = {
      active_run_id: 'r2',
      scheduler: {
        as_of: 1,
        queued: [{ run_id: 'r1', status: 'queued', queue_position: 1, wait_reason: 'model_slot' }],
        running: [{ run_id: 'r2', status: 'running' }],
        stats: { queued: 1, running: 1, completed: 0, failed: 0, cancelled: 0 },
      },
    };
    expect(runtimeQueueRows(runtime).map((row) => row.run_id)).toEqual(['r1', 'r2']);
    expect(runtimeQueueRows(runtime)[0]?.wait_reason).toBe('model_slot');
    expect(runtimeQueueRows(undefined)).toEqual([]);
  });
});
