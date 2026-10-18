import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { MetricsCollector } from '../src/observability/metrics';

function emit(
  stream: MemoryEventStream,
  type: string,
  data: Record<string, unknown> = {},
  runId = 'run-1',
) {
  stream.publish({ type, run_id: runId, data, ts: Date.now() });
}

describe('MetricsCollector (0.4 C2)', () => {
  it('starts from an all-zero snapshot', () => {
    const collector = new MetricsCollector(new MemoryEventStream());

    expect(collector.snapshot()).toMatchObject({
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
    });
    expect(collector.snapshot().updated_at).toBeGreaterThan(0);
  });

  it('counts run lifecycle events', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.started');
    emit(stream, 'run.completed', { duration_ms: 10 });
    emit(stream, 'run.failed', { duration_ms: 20 });
    emit(stream, 'run.cancelled');

    expect(collector.snapshot().runs).toEqual({
      started: 1,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });
  });

  it('counts a cancelled run as failed when it surfaces as run.failed', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.started');
    emit(stream, 'run.failed', { error: 'Run cancelled', duration_ms: 5 });

    expect(collector.snapshot().runs).toEqual({
      started: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
    });
  });

  it('aggregates duration total, max and avg', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.completed', { duration_ms: 10 });
    emit(stream, 'run.completed', { duration_ms: 30 });
    emit(stream, 'run.failed', { duration_ms: 20 });

    const duration = collector.snapshot().duration_ms;
    expect(duration.total).toBe(60);
    expect(duration.max).toBe(30);
    expect(duration.avg).toBe(20);
  });

  it('uses completed + failed as the avg denominator even without duration', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.completed', { duration_ms: 10 });
    emit(stream, 'run.completed', {});

    const duration = collector.snapshot().duration_ms;
    expect(duration.total).toBe(10);
    expect(duration.max).toBe(10);
    expect(duration.avg).toBe(5);
  });

  it('keeps avg at 0 when there is no run sample', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.started');

    expect(collector.snapshot().duration_ms.avg).toBe(0);
  });

  it('counts tool call starts and failures', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'tool.call.started');
    emit(stream, 'tool.call.started');
    emit(stream, 'tool.call.started');
    emit(stream, 'tool.call.failed');

    expect(collector.snapshot().tool_calls).toEqual({ total: 3, failed: 1 });
  });

  it('sums llm usage tokens', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'llm.response', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    emit(stream, 'llm.response', {
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    expect(collector.snapshot().llm).toEqual({
      requests: 2,
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
    });
  });

  it('counts requests without usage and leaves tokens at 0', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'llm.response', { finish_reason: 'stop' });

    expect(collector.snapshot().llm).toEqual({
      requests: 1,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('falls back to prompt + completion when total_tokens is absent', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'llm.response', {
      usage: { prompt_tokens: 7, completion_tokens: 4 },
    });

    expect(collector.snapshot().llm.total_tokens).toBe(11);
  });

  it('ignores unrelated events', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);
    const before = collector.snapshot();

    emit(stream, 'context.changed', { message_count: 1 });
    emit(stream, 'llm.request');

    expect(collector.snapshot()).toEqual(before);
  });

  it('reset clears counters but keeps the subscription', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);

    emit(stream, 'run.started');
    emit(stream, 'run.completed', { duration_ms: 10 });
    collector.reset();

    expect(collector.snapshot()).toMatchObject({
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
    });

    emit(stream, 'run.started');
    expect(collector.snapshot().runs.started).toBe(1);
  });

  it('dispose unsubscribes, is idempotent and leaves the stream usable', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);
    const other: string[] = [];
    stream.subscribe((event) => {
      other.push(event.type);
    });

    emit(stream, 'run.started');
    collector.dispose();
    collector.dispose();
    emit(stream, 'run.started');

    expect(collector.snapshot().runs.started).toBe(1);
    expect(other).toEqual(['run.started', 'run.started']);
  });

  it('returns snapshots that cannot mutate internal state', () => {
    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);
    emit(stream, 'run.started');

    const first = collector.snapshot();
    first.runs.started = 999;
    first.duration_ms.max = 999;

    expect(collector.snapshot().runs.started).toBe(1);
    expect(collector.snapshot().duration_ms.max).toBe(0);
  });
});
