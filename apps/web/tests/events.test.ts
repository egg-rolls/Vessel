import { describe, expect, test } from 'bun:test';
import type { RunEvent, SessionDetail } from '../src/gateway/types';
import {
  type EventMeta,
  EventStore,
  MAX_EVENTS_PER_RUN,
  MAX_EVENTS_TOTAL,
} from '../src/state/event-store';
import {
  buildGroup,
  groupEvents,
  isGroupPersisted,
  isVisibleForGrouping,
  type StoredEvent,
} from '../src/state/events';

function event(runId: string, type: string, data: Record<string, unknown> = {}, ts = 1): RunEvent {
  return { type, run_id: runId, data, ts };
}

function stored(
  runId: string,
  type: string,
  seq: number,
  data: Record<string, unknown> = {},
  ts = 1,
): StoredEvent {
  return { event: event(runId, type, data, ts), seq };
}

describe('buildGroup', () => {
  test('merges text deltas and captures run lifecycle fields', () => {
    const entries: StoredEvent[] = [
      stored('r1', 'run.started', 1, { input: 'hi', session_id: 's1' }, 100),
      stored('r1', 'llm.stream.chunk', 2, { chunk: { type: 'text_delta', delta: 'Hel' } }, 101),
      stored('r1', 'llm.stream.chunk', 3, { chunk: { type: 'text_delta', delta: 'lo' } }, 102),
      stored('r1', 'tool.call.started', 4, { tool_name: 'bash' }, 103),
      stored('r1', 'llm.stream.chunk', 5, { chunk: { type: 'finish' } }, 104),
      stored('r1', 'run.completed', 6, { output: 'Hello', duration_ms: 42, iterations: 2 }, 105),
    ];
    const group = buildGroup('r1', entries);
    expect(group.input).toBe('hi');
    expect(group.sessionId).toBe('s1');
    expect(group.status).toBe('completed');
    expect(group.output).toBe('Hello');
    expect(group.durationMs).toBe(42);
    expect(group.iterations).toBe(2);
    const texts = group.items
      .filter((item): item is { kind: 'text'; text: string; key: string } => item.kind === 'text')
      .map((item) => item.text);
    expect(texts).toEqual(['Hello']);
    expect(group.items.some((item) => item.kind === 'event')).toBe(true);
  });

  test('records failed and cancelled terminal states', () => {
    expect(buildGroup('r1', [stored('r1', 'run.failed', 1, { error: 'boom' })]).status).toBe(
      'failed',
    );
    expect(buildGroup('r1', [stored('r1', 'run.cancelled', 1)]).status).toBe('cancelled');
  });
});

describe('live streaming buffers (0.17)', () => {
  test('keeps unfinished text deltas in liveText without pushing an item', () => {
    const group = buildGroup('r1', [
      stored('r1', 'run.started', 1, {}, 100),
      stored('r1', 'llm.stream.chunk', 2, { chunk: { type: 'text_delta', delta: 'Hel' } }, 101),
      stored('r1', 'llm.stream.chunk', 3, { chunk: { type: 'text_delta', delta: 'lo' } }, 102),
    ]);
    expect(group.status).toBe('running');
    expect(group.liveText).toBe('Hello');
    expect(group.items.some((item) => item.kind === 'text')).toBe(false);
  });

  test('finish flushes live text into an item and clears liveText', () => {
    const group = buildGroup('r1', [
      stored('r1', 'run.started', 1, {}, 100),
      stored('r1', 'llm.stream.chunk', 2, { chunk: { type: 'text_delta', delta: 'Hello' } }, 101),
      stored('r1', 'llm.stream.chunk', 3, { chunk: { type: 'finish' } }, 102),
    ]);
    expect(group.liveText).toBeUndefined();
    const texts = group.items
      .filter((item): item is { kind: 'text'; text: string; key: string } => item.kind === 'text')
      .map((item) => item.text);
    expect(texts).toEqual(['Hello']);
  });

  test('keeps unfinished reasoning deltas in liveReasoning and clears after finish', () => {
    const entries = [
      stored('r1', 'run.started', 1, {}, 100),
      stored('r1', 'llm.stream.chunk', 2, { chunk: { type: 'reasoning_delta', delta: 'th' } }, 101),
      stored(
        'r1',
        'llm.stream.chunk',
        3,
        { chunk: { type: 'reasoning_delta', delta: 'ink' } },
        102,
      ),
    ];
    const live = buildGroup('r1', entries);
    expect(live.liveReasoning).toBe('think');
    expect(live.items.some((item) => item.kind === 'reasoning')).toBe(false);

    const flushed = buildGroup('r1', [
      ...entries,
      stored('r1', 'llm.stream.chunk', 4, { chunk: { type: 'finish' } }, 103),
    ]);
    expect(flushed.liveReasoning).toBeUndefined();
    expect(
      flushed.items.filter((item) => item.kind === 'reasoning').map((item) => item.text),
    ).toEqual(['think']);
  });

  test('switching from reasoning to text flushes reasoning before the live body', () => {
    const group = buildGroup('r1', [
      stored(
        'r1',
        'llm.stream.chunk',
        1,
        { chunk: { type: 'reasoning_delta', delta: 'why' } },
        100,
      ),
      stored('r1', 'llm.stream.chunk', 2, { chunk: { type: 'text_delta', delta: 'answer' } }, 101),
    ]);
    expect(group.liveReasoning).toBeUndefined();
    expect(group.liveText).toBe('answer');
    expect(
      group.items.filter((item) => item.kind === 'reasoning').map((item) => item.text),
    ).toEqual(['why']);
  });
});

describe('user.message', () => {
  test('user.message 被渲染成 raw JSON 卡且输入用改写前文本', () => {
    const group = buildGroup('r1', [
      stored('r1', 'run.started', 1, { input: 'raw' }, 100),
      stored('r1', 'user.message', 2, { message: { role: 'user', content: 'rewritten' } }, 101),
    ]);
    expect(group.input).toBe('rewritten');
    expect(group.items.some((item) => item.kind === 'event')).toBe(false);
  });

  test('旧日志只有 run.started 时用户输入丢失（未回退 input）', () => {
    const group = buildGroup('r1', [stored('r1', 'run.started', 1, { input: 'raw' }, 100)]);
    expect(group.input).toBe('raw');
    expect(group.items.some((item) => item.kind === 'event')).toBe(false);
  });
});

describe('groupEvents', () => {
  test('hides internal, subagent and internal-level errors by default', () => {
    const entries = [
      stored('r1', 'run.started', 1, {}, 10),
      stored('r1', 'llm.request', 2, {}, 11),
      stored('child', 'subagent.started', 3, {}, 12),
      stored('r1', 'error', 4, { error: 'x' }, 13),
    ];
    const groups = groupEvents(entries, false);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.filter((item) => item.kind === 'event')).toHaveLength(0);
  });

  test('keeps run/tool/permission errors at user level, hides internal at all level only when asked', () => {
    const entries = [
      stored('r1', 'run.started', 1, {}, 10),
      stored('r1', 'tool.call.failed', 2, { tool_name: 'bash' }, 11),
      stored('r1', 'permission.respond.failed', 3, { error: 'denied' }, 12),
      stored('r1', 'hook.error', 4, { error: 'hook' }, 13),
    ];
    const user = groupEvents(entries, false);
    const types = user[0]?.items
      .filter((item) => item.kind === 'event')
      .map((item) => (item.kind === 'event' ? item.event.type : ''))
      .sort();
    expect(types).toEqual(['permission.respond.failed', 'tool.call.failed']);

    const all = groupEvents(entries, false, 'all');
    expect(
      all[0]?.items.filter((item) => item.kind === 'event' && item.event.type === 'hook.error'),
    ).toHaveLength(1);
  });

  test('captures additive error metadata on failed runs', () => {
    const group = buildGroup('r1', [
      stored(
        'r1',
        'run.failed',
        1,
        {
          error: 'boom',
          error_code: 'provider_timeout',
          category: 'provider',
          phase: 'llm',
          retryable: true,
          http_status: 504,
        },
        10,
      ),
    ]);
    expect(group.errorMeta).toEqual({
      code: 'provider_timeout',
      category: 'provider',
      phase: 'llm',
      retryable: true,
      httpStatus: 504,
    });
  });

  test('showInternal keeps internal events and groups by run', () => {
    const entries = [
      stored('r1', 'run.started', 1, {}, 10),
      stored('r2', 'run.started', 2, {}, 5),
      stored('r1', 'llm.request', 3, {}, 11),
    ];
    const groups = groupEvents(entries, true);
    expect(groups.map((group) => group.runId)).toEqual(['r2', 'r1']);
    const items = groups.find((group) => group.runId === 'r1')?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'event' ? items[0].event.type : '').toBe('llm.request');
  });
});

describe('isGroupPersisted', () => {
  const group = {
    ...buildGroup('r1', []),
    status: 'completed' as const,
    input: 'hi',
    output: 'done',
  };
  const detail = (messages: SessionDetail['messages']): SessionDetail => ({
    session_id: 's1',
    messages,
  });

  test('requires both user input and final output in history', () => {
    expect(isGroupPersisted(group, detail([]))).toBe(false);
    expect(isGroupPersisted(group, detail([{ role: 'user', content: 'hi' }]))).toBe(false);
    expect(
      isGroupPersisted(
        group,
        detail([
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'done' },
        ]),
      ),
    ).toBe(true);
  });

  test('does not hide incomplete runs or empty output', () => {
    expect(
      isGroupPersisted(
        { ...group, status: 'running' },
        detail([
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'done' },
        ]),
      ),
    ).toBe(false);
    expect(
      isGroupPersisted(
        { ...group, output: undefined },
        detail([
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'done' },
        ]),
      ),
    ).toBe(false);
  });
});

function meta(seq: number, jobId?: string): EventMeta {
  return { seq, ...(jobId ? { jobId } : {}) };
}

describe('EventStore', () => {
  test('deduplicates out-of-order and repeated seq values', () => {
    const store = new EventStore(0);
    expect(store.push(event('r1', 'run.started'), meta(5))).toBe(true);
    expect(store.push(event('r1', 'run.started'), meta(5))).toBe(false);
    expect(store.push(event('r1', 'run.started'), meta(4))).toBe(false);
    store.flush();
    expect(store.getSnapshot().entries).toHaveLength(1);
    expect(store.currentSeq).toBe(5);
  });

  test('caps each run and marks it truncated', () => {
    const store = new EventStore(0);
    const total = MAX_EVENTS_PER_RUN + 5;
    for (let seq = 1; seq <= total; seq += 1) {
      store.push(event('r1', 'llm.stream.chunk'), meta(seq));
    }
    store.flush();
    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(snapshot.truncatedRuns.has('r1')).toBe(true);
    expect(snapshot.entries.at(-1)?.seq).toBe(total);
  });

  test('caps the total buffer by dropping the oldest events', () => {
    const store = new EventStore(0);
    const runs = 6;
    let seq = 0;
    for (let run = 0; run < runs; run += 1) {
      for (let index = 0; index < MAX_EVENTS_PER_RUN; index += 1) {
        seq += 1;
        store.push(event(`run-${run}`, 'llm.stream.chunk'), meta(seq));
      }
    }
    store.flush();
    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toHaveLength(MAX_EVENTS_TOTAL);
    expect(snapshot.truncatedRuns.has('run-0')).toBe(true);
    expect(snapshot.entries.at(-1)?.seq).toBe(runs * MAX_EVENTS_PER_RUN);
  });

  test('truncatedSince is a per-snapshot delta, cleared by flush and reset', () => {
    const store = new EventStore(0);
    const total = MAX_EVENTS_PER_RUN + 1;
    for (let seq = 1; seq <= total; seq += 1) {
      store.push(event('r1', 'llm.stream.chunk'), meta(seq));
    }
    store.flush();
    expect(store.getSnapshot().truncatedSince.has('r1')).toBe(true);
    expect(store.getSnapshot().truncatedRuns.has('r1')).toBe(true);

    // 没有新裁剪的下一份快照：增量集合为空，累计集合保留。
    store.flush();
    expect(store.getSnapshot().truncatedSince.size).toBe(0);
    expect(store.getSnapshot().truncatedRuns.has('r1')).toBe(true);

    // 未发布的裁剪在 reset 后也不得泄漏到下一份快照。
    store.push(event('r1', 'llm.stream.chunk'), meta(total + 1));
    store.reset();
    expect(store.getSnapshot().truncatedSince.size).toBe(0);
    store.push(event('r1', 'run.started'), meta(1));
    store.flush();
    expect(store.getSnapshot().truncatedSince.size).toBe(0);
  });

  test('reset clears entries and resumes from the requested seq', () => {
    const store = new EventStore(0);
    store.push(event('r1', 'run.started'), meta(3));
    store.reset(10);
    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.lastSeq).toBe(10);
    expect(snapshot.truncatedRuns.size).toBe(0);
    expect(store.push(event('r1', 'run.started'), meta(9))).toBe(false);
    expect(store.push(event('r1', 'run.started'), meta(11))).toBe(true);
  });

  test('notifies subscribers with a new snapshot version', () => {
    const store = new EventStore(0);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.push(event('r1', 'run.started'), meta(1));
    store.flush();
    expect(calls).toBe(1);
    const first = store.getSnapshot();
    store.push(event('r1', 'run.completed'), meta(2));
    store.flush();
    expect(calls).toBe(2);
    expect(store.getSnapshot().version).toBeGreaterThan(first.version);
    off();
    store.flush();
    expect(calls).toBe(2);
  });

  test('publishes a new entries array so memoized views update in real time', () => {
    const store = new EventStore(1_000);
    store.push(event('r1', 'run.started'), meta(1));
    store.flush();
    const first = store.getSnapshot();

    store.push(
      event('r1', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'hi' } }),
      meta(2),
    );
    store.flush();
    const second = store.getSnapshot();

    // 消费者用 useMemo(..., [snapshot.entries]) 派生视图：引用必须变化。
    expect(second.entries).not.toBe(first.entries);
    // 旧快照不能被后续 push 污染。
    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(2);
    expect(second.entries.at(-1)?.event.type).toBe('llm.stream.chunk');
  });
});

describe('message.injected stays internal by default (0.27)', () => {
  test('message.injected is internal unless internal events are shown', () => {
    const entry = stored('r1', 'message.injected', 1, {
      message: { role: 'user', name: 'agent:worker', content: 'member reply' },
    });
    expect(isVisibleForGrouping(entry, false)).toBe(false);
    expect(isVisibleForGrouping(entry, true)).toBe(true);
  });
});
