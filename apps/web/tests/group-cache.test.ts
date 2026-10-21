import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '../src/gateway/types';
import type { StoredEvent } from '../src/state/events';
import { EventGroupCache } from '../src/state/group-cache';

function event(type: string, runId: string, data: Record<string, unknown>, ts: number): RunEvent {
  return { type, run_id: runId, data, ts };
}

function stored(ev: RunEvent, seq: number): StoredEvent {
  return { event: ev, seq };
}

function started(runId: string, ts: number, seq: number): StoredEvent {
  return stored(
    event('run.started', runId, { session_id: `session-${runId}`, input: runId }, ts),
    seq,
  );
}

function delta(runId: string, text: string, ts: number, seq: number): StoredEvent {
  return stored(
    event('llm.stream.chunk', runId, { chunk: { type: 'text_delta', delta: text } }, ts),
    seq,
  );
}

describe('EventGroupCache', () => {
  test('appending tokens rebuilds only the changed run and reuses unchanged groups', () => {
    const cache = new EventGroupCache();
    const base = [
      started('run-a', 100, 1),
      started('run-b', 200, 2),
      delta('run-a', 'a1', 110, 3),
      delta('run-b', 'b1', 210, 4),
    ];
    const first = cache.group(base, false);
    expect(first).toHaveLength(2);
    const firstA = first[0];
    const firstB = first[1];
    expect(firstA?.runId).toBe('run-a');
    expect(firstB?.runId).toBe('run-b');
    expect(firstA?.liveText).toBe('a1');

    const next = [...base, delta('run-a', 'a2', 120, 5)];
    const second = cache.group(next, false);

    expect(second).toHaveLength(2);
    // 未变更的 run-b 保持同一引用；run-a 因新增 token 重建。
    expect(second[1]).toBe(firstB);
    expect(second[0]).not.toBe(firstA);
    // 0.17：未 finish 的流式尾部留在 liveText，不 push 成 item。
    expect(second[0]?.liveText).toBe('a1a2');
    expect(second[0]?.items.some((item) => item.kind === 'text')).toBe(false);
    expect(cache.stats.rebuiltRuns).toBe(1);
    expect(cache.stats.reusedRuns).toBe(1);
    expect(cache.stats.appendedEntries).toBe(1);
    expect(cache.stats.fullRebuilds).toBe(1);
  });

  test('visibility changes discard the whole cache instead of reusing filtered groups', () => {
    const cache = new EventGroupCache();
    const entries = [
      started('run-a', 100, 1),
      stored(event('context.changed', 'run-a', { reason: 'internal' }, 105), 2),
      delta('run-a', 'visible', 110, 3),
    ];
    const hidden = cache.group(entries, false);
    expect(hidden[0]?.items.some((item) => item.kind === 'event')).toBe(false);

    const shown = cache.group(entries, true);
    expect(shown[0]?.items.some((item) => item.kind === 'event')).toBe(true);
    expect(cache.stats.fullRebuilds).toBe(2);

    // 同一份输入 + 同一设置再次调用时直接返回缓存数组。
    expect(cache.group(entries, true)).toBe(shown);
  });
});
