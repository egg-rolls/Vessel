import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '../src/gateway/types';
import {
  filterRunEvents,
  groupRunEvents,
  isErrorEvent,
  isInternalEvent,
  isTraceUnavailable,
  mergeRunEvents,
  nextSinceSeq,
  type ToolCallGroup,
  traceRunId,
} from '../src/state/run-detail';

function event(
  type: string,
  data: Record<string, unknown> = {},
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return { type, run_id: 'r1', data, ts: 100, ...overrides };
}

describe('event classification', () => {
  test('internal events include known types and subagent namespaces', () => {
    expect(isInternalEvent('context.changed')).toBe(true);
    expect(isInternalEvent('llm.request')).toBe(true);
    expect(isInternalEvent('subagent.started')).toBe(true);
    expect(isInternalEvent('tool.call.started')).toBe(false);
  });

  test('failed tool calls count as errors and tools', () => {
    expect(isErrorEvent('tool.call.failed')).toBe(true);
    expect(isErrorEvent('run.failed')).toBe(true);
    expect(isErrorEvent('guardrail.blocked')).toBe(true);
    expect(isErrorEvent('tool.call.completed')).toBe(false);
  });
});

describe('filterRunEvents', () => {
  const events = [
    event('run.started'),
    event('llm.request'),
    event('llm.response'),
    event('tool.call.started'),
    event('tool.call.failed'),
    event('guardrail.blocked'),
    event('context.changed'),
    event('other.thing'),
  ];

  test('hides internal events by default', () => {
    const filtered = filterRunEvents(events);
    expect(filtered.map((entry) => entry.type)).toEqual([
      'run.started',
      'tool.call.started',
      'tool.call.failed',
      'guardrail.blocked',
      'other.thing',
    ]);
  });

  test('internal filter shows internal events regardless of the toggle', () => {
    const filtered = filterRunEvents(events, { filter: 'internal' });
    expect(filtered.map((entry) => entry.type)).toEqual([
      'llm.request',
      'llm.response',
      'context.changed',
    ]);
  });

  test('tool and error filters overlap on tool.call.failed', () => {
    expect(filterRunEvents(events, { filter: 'tools' }).map((entry) => entry.type)).toEqual([
      'tool.call.started',
      'tool.call.failed',
    ]);
    expect(filterRunEvents(events, { filter: 'errors' }).map((entry) => entry.type)).toEqual([
      'tool.call.failed',
      'guardrail.blocked',
    ]);
  });

  test('type prefix is case-insensitive and combines with the toggle', () => {
    expect(
      filterRunEvents(events, { typePrefix: 'TOOL.CALL.' }).map((entry) => entry.type),
    ).toEqual(['tool.call.started', 'tool.call.failed']);
    expect(
      filterRunEvents(events, { typePrefix: 'llm.', showInternal: true }).map(
        (entry) => entry.type,
      ),
    ).toEqual(['llm.request', 'llm.response']);
  });

  test('other excludes known categories', () => {
    expect(filterRunEvents(events, { filter: 'other' }).map((entry) => entry.type)).toEqual([
      'run.started',
      'other.thing',
    ]);
  });
});

describe('groupRunEvents', () => {
  test('pairs started/completed by tool_call_id', () => {
    const items = groupRunEvents([
      event('tool.call.started', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        arguments: { cmd: 'ls' },
      }),
      event('run.started'),
      event('tool.call.completed', {
        tool_call_id: 'c1',
        tool_name: 'bash',
        result: 'ok',
        duration_ms: 12,
      }),
    ]);
    expect(items).toHaveLength(2);
    const tool = items[0] as ToolCallGroup;
    expect(tool.kind).toBe('tool');
    expect(tool.status).toBe('completed');
    expect(tool.name).toBe('bash');
    expect(tool.arguments).toEqual({ cmd: 'ls' });
    expect(tool.result).toBe('ok');
    expect(tool.durationMs).toBe(12);
    expect(items[1]?.kind).toBe('event');
  });

  test('failed calls attach the error and keep unpaired events standalone', () => {
    const items = groupRunEvents([
      event('tool.call.started', { tool_call_id: 'c1', tool_name: 'read' }),
      event('tool.call.failed', {
        tool_call_id: 'c1',
        tool_name: 'read',
        error: 'denied',
      }),
      event('tool.call.completed', { tool_name: 'orphan', result: 'x' }),
    ]);
    const paired = items[0] as ToolCallGroup;
    expect(paired.status).toBe('failed');
    expect(paired.error).toBe('denied');
    const standalone = items[1] as ToolCallGroup;
    expect(standalone.kind).toBe('tool');
    expect(standalone.status).toBe('completed');
    expect(standalone.started).toBeUndefined();
  });
});

describe('mergeRunEvents', () => {
  test('dedupes by seq and by type+ts', () => {
    const trace = [event('run.started', {}, { seq: 1, ts: 10 })];
    const live = [
      event('run.started', {}, { seq: 1, ts: 10 }),
      event('run.started', {}, { ts: 10 }),
      event('llm.stream.chunk', {}, { ts: 11 }),
    ];
    const merged = mergeRunEvents(trace, live);
    expect(merged.map((entry) => entry.type)).toEqual(['run.started', 'llm.stream.chunk']);
  });

  test('nextSinceSeq returns the last numeric seq', () => {
    expect(nextSinceSeq([event('a', {}, { seq: 4 }), event('b', {}, { ts: 2 })])).toBe(4);
    expect(nextSinceSeq([event('a'), event('b')])).toBeUndefined();
    expect(nextSinceSeq([])).toBeUndefined();
  });
});

describe('traceRunId', () => {
  test('live detail reads trace by core_run_id, never the engine job id', () => {
    expect(traceRunId('live', { run_id: 'job-1', core_run_id: 'core-1' }, 'job-1')).toBe('core-1');
    // 排队中尚未映射到 core run：不能拿引擎 id 去猜。
    expect(traceRunId('live', { run_id: 'job-1' }, 'job-1')).toBeUndefined();
    expect(traceRunId('live', null, 'job-1')).toBeUndefined();
  });

  test('durable detail uses the checkpoint id (already a core run id)', () => {
    expect(traceRunId('durable', { run_id: 'core-1' }, 'route-1')).toBe('core-1');
    expect(traceRunId('durable', null, 'route-1', 'core-2')).toBe('core-2');
    expect(traceRunId('durable', null, 'route-1')).toBe('route-1');
  });
});

describe('isTraceUnavailable', () => {
  test('treats missing trace reader as an explanation state', () => {
    expect(
      isTraceUnavailable({ code: 'not_found', message: 'Trace reader is not available' }),
    ).toBe(true);
    expect(isTraceUnavailable({ message: 'method_not_allowed: events.list' })).toBe(true);
  });

  test('keeps network failures retryable', () => {
    expect(isTraceUnavailable({ message: 'network: Failed to fetch' })).toBe(false);
  });
});
