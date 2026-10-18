import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { MetricsCollector, type RunEvent } from '../../packages/core/src/index';
import {
  createEventBus,
  createEventStream,
  createMetricsCollector,
  disposeMetrics,
  isObservabilityConfigured,
  resolveEventHistory,
} from '../observability-wiring';

function event(type: string, data: Record<string, unknown> = {}): RunEvent {
  return { type, run_id: 'run-1', data, ts: Date.now() };
}

describe('activation semantics', () => {
  it('absent block: no collector, default stream limit 1000', () => {
    const config: VesselConfig = {};
    expect(isObservabilityConfigured(config)).toBe(false);
    expect(resolveEventHistory(config)).toBeUndefined();

    const stream = createEventStream(config);
    for (let i = 0; i < 1001; i++) stream.publish(event('run.started'));
    expect(stream.getHistory()).toHaveLength(1000);
  });

  it('present block without event_history: limit 1000', () => {
    const config: VesselConfig = { observability: {} };
    expect(isObservabilityConfigured(config)).toBe(true);
    expect(resolveEventHistory(config)).toBe(1000);

    const stream = createEventStream(config);
    for (let i = 0; i < 1001; i++) stream.publish(event('run.started'));
    expect(stream.getHistory()).toHaveLength(1000);
  });

  it('explicit 0 means unlimited', () => {
    const config: VesselConfig = { observability: { eventHistory: 0 } };
    expect(resolveEventHistory(config)).toBe(0);

    const stream = createEventStream(config);
    for (let i = 0; i < 1500; i++) stream.publish(event('run.started'));
    expect(stream.getHistory()).toHaveLength(1500);
  });

  it('positive event_history is a ring buffer', () => {
    const config: VesselConfig = { observability: { eventHistory: 5 } };
    const stream = createEventStream(config);
    for (let i = 0; i < 10; i++) stream.publish(event('run.started'));
    expect(stream.getHistory()).toHaveLength(5);
  });

  it('host event bus applies the same limit', () => {
    const bus = createEventBus({ observability: { eventHistory: 3 } });
    for (let i = 0; i < 10; i++) bus.publish(event('run.started'));
    expect(bus.getHistory()).toHaveLength(3);
  });
});

describe('metrics collector', () => {
  it('absent block does not create a collector', () => {
    const stream = createEventStream({});
    expect(createMetricsCollector(stream, {})).toBeUndefined();
  });

  it('metrics:false does not create a collector', () => {
    const stream = createEventStream({ observability: { metrics: false } });
    expect(createMetricsCollector(stream, { observability: { metrics: false } })).toBeUndefined();
  });

  it('aggregates existing events and disposes cleanly', () => {
    const config: VesselConfig = { observability: {} };
    const stream = createEventStream(config);
    const metrics = createMetricsCollector(stream, config);
    expect(metrics).toBeInstanceOf(MetricsCollector);

    stream.publish(event('run.started'));
    stream.publish(event('run.completed', { duration_ms: 100 }));
    stream.publish(event('run.failed', { duration_ms: 300 }));
    stream.publish(event('tool.call.started'));
    stream.publish(event('tool.call.failed'));
    stream.publish(
      event('llm.response', {
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );

    expect(metrics?.snapshot()).toMatchObject({
      runs: { started: 1, completed: 1, failed: 1, cancelled: 0 },
      tool_calls: { total: 1, failed: 1 },
      llm: { requests: 1, prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      duration_ms: { total: 400, max: 300, avg: 200 },
    });

    disposeMetrics(metrics);
    stream.publish(event('run.started'));
    expect(metrics?.snapshot().runs.started).toBe(1);
  });

  it('disposeMetrics tolerates undefined', () => {
    expect(() => disposeMetrics(undefined)).not.toThrow();
  });
});
