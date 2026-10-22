import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '../src/gateway/types';
import { EventStore, MAX_EVENTS_PER_RUN } from '../src/state/event-store';
import { groupEvents, type StoredEvent } from '../src/state/events';
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

  test('run past MAX_EVENTS_PER_RUN keeps incremental rebuilds', () => {
    const store = new EventStore(0);
    let seq = 0;
    const push = (runId: string, type: string, data: Record<string, unknown>, ts: number) => {
      seq += 1;
      store.push(event(type, runId, data, ts), { seq });
    };
    push('run-a', 'run.started', { session_id: 's-a', input: 'a' }, 100);
    for (let index = 0; index < MAX_EVENTS_PER_RUN - 1; index += 1) {
      push('run-a', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'x' } }, 101);
    }
    store.flush();
    const first = store.getSnapshot();
    const cache = new EventGroupCache();
    cache.group(first.entries, false, 'user', first.truncatedSince);
    expect(cache.stats.fullRebuilds).toBe(1);

    // 每条新事件都会裁掉最旧一条：数组长度不变，但 seq 仍单调增长。
    for (let index = 0; index < 5; index += 1) {
      push('run-a', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'y' } }, 400 + index);
    }
    store.flush();
    const second = store.getSnapshot();
    expect(second.entries).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(second.truncatedSince.has('run-a')).toBe(true);

    const groups = cache.group(second.entries, false, 'user', second.truncatedSince);
    expect(cache.stats.fullRebuilds).toBe(1);
    expect(cache.stats.rebuiltRuns).toBe(1);
    // 最旧的 run.started 与 delta 被真正丢掉，局部重建结果与全量口径一致。
    expect(groups).toEqual(groupEvents(second.entries, false));
  });

  test('truncating one saturated run preserves other run references', () => {
    const store = new EventStore(0);
    let seq = 0;
    const push = (runId: string, type: string, data: Record<string, unknown>, ts: number) => {
      seq += 1;
      store.push(event(type, runId, data, ts), { seq });
    };
    push('run-a', 'run.started', { session_id: 's-a', input: 'a' }, 100);
    for (let index = 0; index < MAX_EVENTS_PER_RUN - 1; index += 1) {
      push('run-a', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'a' } }, 101);
    }
    push('run-b', 'run.started', { session_id: 's-b', input: 'b' }, 200);
    push('run-b', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'b' } }, 201);

    store.flush();
    const first = store.getSnapshot();
    const cache = new EventGroupCache();
    const firstGroups = cache.group(first.entries, false, 'user', first.truncatedSince);
    expect(firstGroups).toHaveLength(2);
    const firstB = firstGroups.find((group) => group.runId === 'run-b');
    expect(firstB).toBeDefined();

    push('run-a', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'c' } }, 300);
    store.flush();
    const second = store.getSnapshot();
    const secondGroups = cache.group(second.entries, false, 'user', second.truncatedSince);

    expect(secondGroups).toHaveLength(2);
    // 只有被裁剪 / 追加的 run-a 重建；run-b 的 RunGroup 引用必须保持。
    expect(secondGroups.find((group) => group.runId === 'run-b')).toBe(firstB);
    expect(secondGroups.find((group) => group.runId === 'run-a')).not.toBe(
      firstGroups.find((group) => group.runId === 'run-a'),
    );
    expect(cache.stats.rebuiltRuns).toBe(1);
    expect(cache.stats.reusedRuns).toBe(1);
    expect(cache.stats.fullRebuilds).toBe(1);
  });

  test('dropping the oldest delta after truncation matches a full rebuild', () => {
    const cache = new EventGroupCache();
    const base = [
      delta('run-a', 'A', 100, 1),
      delta('run-a', 'B', 101, 2),
      delta('run-a', 'C', 102, 3),
    ];
    expect(cache.group(base, false)[0]?.liveText).toBe('ABC');

    // 首条 delta 被裁剪，后续继续追加。
    const trimmed = [
      delta('run-a', 'B', 101, 2),
      delta('run-a', 'C', 102, 3),
      delta('run-a', 'D', 103, 4),
    ];
    const groups = cache.group(trimmed, false, 'user', new Set(['run-a']));
    expect(groups).toEqual(groupEvents(trimmed, false));
    expect(groups[0]?.liveText).toBe('BCD');
    expect(cache.stats.fullRebuilds).toBe(1);
  });

  test('run whose bucket becomes empty is removed instead of staying as a ghost group', () => {
    const cache = new EventGroupCache();
    const base = [delta('run-b', 'b', 100, 1), started('run-a', 200, 2)];
    expect(cache.group(base, false).map((group) => group.runId)).toEqual(['run-b', 'run-a']);

    // run-b 的可见事件全部被裁剪，run-a 继续追加。
    const next = [started('run-a', 200, 2), delta('run-a', 'x', 201, 3)];
    const groups = cache.group(next, false, 'user', new Set(['run-b']));
    expect(groups.map((group) => group.runId)).toEqual(['run-a']);
    expect(groups).toEqual(groupEvents(next, false));
    expect(cache.stats.rebuiltRuns).toBe(1);
  });
});
