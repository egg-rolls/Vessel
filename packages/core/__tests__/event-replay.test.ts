/**
 * 事件回放测试
 *
 * FileEventStore 测试（需 tmpdir）+ replayRun 测试（纯 in-memory）
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileEventStore, MemoryEventStream, replayRun } from '../src/events/index.js';
import type { RunEvent } from '../src/types/event.js';
import { EventType } from '../src/types/event.js';

// ── 事件 fixture ──────────────────────────────────

function makeEvent(type: EventType, runId: string, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type,
    run_id: runId,
    data: { run_id: runId, event_count: 0 },
    ts: 1700000000000,
    ...overrides,
  };
}

/** subscribe 包装——避免 push() 返回值与 void 类型冲突 */
function collectEvents(stream: MemoryEventStream): RunEvent[] {
  const events: RunEvent[] = [];
  stream.subscribe((e) => {
    events.push(e);
  });
  return events;
}

// ── FileEventStore 测试 ────────────────────────────

describe('FileEventStore', () => {
  let tmpDir: string;
  let storePath: string;
  let store: FileEventStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-er-'));
    storePath = path.join(tmpDir, 'events.jsonl');
    store = new FileEventStore(storePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should append and read back events', async () => {
    const event = makeEvent(EventType.RunStarted, 'run-1', {
      data: { run_id: 'run-1', input: 'hello' },
    });

    await store.append(event);
    const read = await store.readRun('run-1');

    expect(read).toHaveLength(1);
    expect(read[0]?.type).toBe(EventType.RunStarted);
    expect(read[0]?.run_id).toBe('run-1');
  });

  it('should return empty array for non-existent run', async () => {
    const event = makeEvent(EventType.RunStarted, 'run-1');
    await store.append(event);

    const read = await store.readRun('run-nonexistent');
    expect(read).toHaveLength(0);
  });

  it('should list run IDs from persisted events', async () => {
    await store.append(makeEvent(EventType.RunStarted, 'run-a'));
    await store.append(makeEvent(EventType.RunCompleted, 'run-a'));
    await store.append(makeEvent(EventType.RunStarted, 'run-b'));

    const ids = await store.listRunIds();
    // 排序后比较（Set 迭代顺序可能与插入顺序不完全一致）
    const sorted = [...ids].sort();
    expect(sorted).toEqual(['run-a', 'run-b']);
  });

  it('should return empty list for non-existent file', async () => {
    const ids = await store.listRunIds();
    expect(ids).toEqual([]);
  });

  it('should delete events for a specific run', async () => {
    await store.append(makeEvent(EventType.RunStarted, 'run-a'));
    await store.append(makeEvent(EventType.RunCompleted, 'run-a'));
    await store.append(makeEvent(EventType.RunStarted, 'run-b'));

    await store.deleteRun('run-a');

    const kept = await store.readRun('run-b');
    expect(kept).toHaveLength(1);

    const removed = await store.readRun('run-a');
    expect(removed).toHaveLength(0);
  });

  it('should handle empty file gracefully', async () => {
    const events = await store.readRun('any-run');
    expect(events).toEqual([]);

    const ids = await store.listRunIds();
    expect(ids).toEqual([]);
  });

  it('should skip malformed JSON lines', async () => {
    // 直接写一行坏数据 + 一行好数据
    const event = makeEvent(EventType.RunCompleted, 'run-1');
    await store.append(event);
    // 手动插入一行坏数据
    const raw = `${JSON.stringify(event)}\n`;
    const badLine = 'not-valid-json\n';
    await Bun.write(storePath, raw + badLine + raw);

    const events = await store.readRun('run-1');
    expect(events).toHaveLength(2); // 两个有效行
  });
});

// ── replayRun 测试 ────────────────────────────────

describe('replayRun', () => {
  let tmpDir: string;
  let storePath: string;
  let store: FileEventStore;
  let eventStream: MemoryEventStream;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-rr-'));
    storePath = path.join(tmpDir, 'events.jsonl');
    store = new FileEventStore(storePath);
    eventStream = new MemoryEventStream();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should replay events to the event stream', async () => {
    await store.append(makeEvent(EventType.RunStarted, 'run-1', { ts: 1000 }));
    await store.append(makeEvent(EventType.RunCompleted, 'run-1', { ts: 2000 }));

    const received = collectEvents(eventStream);

    const count = await replayRun(store, 'run-1', eventStream, { delayMs: 0 });

    expect(count).toBe(2);

    // 过滤掉标记事件，只看原始事件
    const replayed = received.filter(
      (e) => e.type !== EventType.ReplayStarted && e.type !== EventType.ReplayCompleted,
    );
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.type).toBe(EventType.RunStarted);
    expect(replayed[1]?.type).toBe(EventType.RunCompleted);
  });

  it('should emit ReplayStarted before and ReplayCompleted after replayed events', async () => {
    await store.append(makeEvent(EventType.RunStarted, 'run-1', { ts: 1000 }));

    const received = collectEvents(eventStream);

    await replayRun(store, 'run-1', eventStream, { delayMs: 0 });

    expect(received[0]?.type).toBe(EventType.ReplayStarted);
    expect(received[received.length - 1]?.type).toBe(EventType.ReplayCompleted);
  });

  it('should preserve original timestamps on replayed events', async () => {
    const originalTs = 1699999999999;
    await store.append(makeEvent(EventType.RunStarted, 'run-1', { ts: originalTs }));

    const received = collectEvents(eventStream);

    await replayRun(store, 'run-1', eventStream, { delayMs: 0 });

    const replayed = received.find((e) => e.type === EventType.RunStarted);
    expect(replayed?.ts).toBe(originalTs);
  });

  it('should return 0 for non-existent run', async () => {
    const count = await replayRun(store, 'nonexistent', eventStream, { delayMs: 0 });
    expect(count).toBe(0);
  });

  it('should replay events for the correct run only', async () => {
    await store.append(makeEvent(EventType.RunStarted, 'run-1', { ts: 1000 }));
    await store.append(makeEvent(EventType.RunStarted, 'run-2', { ts: 2000 }));
    await store.append(makeEvent(EventType.RunCompleted, 'run-1', { ts: 3000 }));

    const received = collectEvents(eventStream);

    await replayRun(store, 'run-2', eventStream, { delayMs: 0 });

    const replayed = received.filter(
      (e) => e.type !== EventType.ReplayStarted && e.type !== EventType.ReplayCompleted,
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.run_id).toBe('run-2');
  });
});

// ── 集成测试：端到端 ──────────────────────────────

describe('Event replay integration', () => {
  let tmpDir: string;
  let storePath: string;
  let store: FileEventStore;
  let eventStream: MemoryEventStream;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-int-'));
    storePath = path.join(tmpDir, 'events.jsonl');
    store = new FileEventStore(storePath);
    eventStream = new MemoryEventStream();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should produce identical event sequence on replay', async () => {
    // 1. 模拟完整 run 事件序列
    const runId = 'full-run';
    const originalEvents: RunEvent[] = [
      makeEvent(EventType.RunStarted, runId, {
        ts: 1000,
        data: { run_id: runId, input: 'test input' },
      }),
      makeEvent(EventType.LlmRequest, runId, {
        ts: 1100,
        data: { run_id: runId, messages: [{ role: 'user', content: 'test' }] },
      }),
      makeEvent(EventType.LlmResponse, runId, {
        ts: 1200,
        data: { run_id: runId, content: 'response', finish_reason: 'stop' },
      }),
      makeEvent(EventType.RunCompleted, runId, {
        ts: 1300,
        data: {
          run_id: runId,
          output: 'response',
          duration_ms: 300,
          iterations: 1,
        },
      }),
    ];

    // 2. 持久化
    for (const event of originalEvents) {
      await store.append(event);
    }

    // 3. 从文件读回原事件
    const persistedEvents = await store.readRun(runId);
    expect(persistedEvents).toHaveLength(4);

    // 4. 回放
    const subscribed = collectEvents(eventStream);

    const count = await replayRun(store, runId, eventStream, { delayMs: 0 });
    expect(count).toBe(4);

    // 5. 验证回放事件序列（排除 ReplayStarted/ReplayCompleted）
    const replayed = subscribed.filter(
      (e) => e.type !== EventType.ReplayStarted && e.type !== EventType.ReplayCompleted,
    );
    expect(replayed).toHaveLength(4);

    for (let i = 0; i < 4; i++) {
      expect(replayed[i]?.type).toBe(originalEvents[i]?.type);
      expect(replayed[i]?.ts).toBe(originalEvents[i]?.ts);
      expect(replayed[i]?.run_id).toBe(originalEvents[i]?.run_id);
    }
  });
});
