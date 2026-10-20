import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';

function makeEvent(index: number, runId = 'run-1') {
  return {
    type: 'test.event',
    run_id: runId,
    data: { index },
    ts: index,
  };
}

describe('MemoryEventStream history limit (0.4 C2)', () => {
  it('defaults to 1000 (0.3 behavior)', () => {
    const stream = new MemoryEventStream();
    for (let i = 0; i < 1001; i += 1) stream.publish(makeEvent(i));

    const history = stream.getHistory();
    expect(history).toHaveLength(1000);
    expect(history[0]?.data).toEqual({ index: 1 });
    expect(history[999]?.data).toEqual({ index: 1000 });
  });

  it('treats an empty options object as the default 1000', () => {
    const stream = new MemoryEventStream({});
    for (let i = 0; i < 1001; i += 1) stream.publish(makeEvent(i));

    expect(stream.getHistory()).toHaveLength(1000);
  });

  it('keeps only the latest N events when maxHistory > 0', () => {
    const stream = new MemoryEventStream({ maxHistory: 5 });
    for (let i = 0; i < 8; i += 1) stream.publish(makeEvent(i));

    const history = stream.getHistory();
    expect(history.map((e) => e.data)).toEqual([
      { index: 3 },
      { index: 4 },
      { index: 5 },
      { index: 6 },
      { index: 7 },
    ]);
  });

  it('supports the legacy numeric constructor argument', () => {
    const stream = new MemoryEventStream(3);
    for (let i = 0; i < 5; i += 1) stream.publish(makeEvent(i));

    expect(stream.getHistory().map((e) => e.data)).toEqual([
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ]);
  });

  it('treats explicit 0 as unlimited (option form)', () => {
    const stream = new MemoryEventStream({ maxHistory: 0 });
    for (let i = 0; i < 1500; i += 1) stream.publish(makeEvent(i));

    expect(stream.getHistory()).toHaveLength(1500);
  });

  it('treats numeric 0 as unlimited (0.3 form)', () => {
    const stream = new MemoryEventStream(0);
    for (let i = 0; i < 1200; i += 1) stream.publish(makeEvent(i));

    expect(stream.getHistory()).toHaveLength(1200);
  });

  it('treats negative and non-finite limits as unlimited', () => {
    const negative = new MemoryEventStream(-5);
    const notFinite = new MemoryEventStream({ maxHistory: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 1100; i += 1) {
      negative.publish(makeEvent(i));
      notFinite.publish(makeEvent(i));
    }

    expect(negative.getHistory()).toHaveLength(1100);
    expect(notFinite.getHistory()).toHaveLength(1100);
  });

  it('filters the retained ring by run_id', () => {
    const stream = new MemoryEventStream({ maxHistory: 4 });
    stream.publish(makeEvent(0, 'a'));
    stream.publish(makeEvent(1, 'b'));
    stream.publish(makeEvent(2, 'a'));
    stream.publish(makeEvent(3, 'b'));
    stream.publish(makeEvent(4, 'a'));

    expect(stream.getHistory('a').map((e) => e.data)).toEqual([{ index: 2 }, { index: 4 }]);
    expect(stream.getHistory('b').map((e) => e.data)).toEqual([{ index: 1 }, { index: 3 }]);
  });

  it('clear resets both ring and unlimited history', () => {
    const ring = new MemoryEventStream({ maxHistory: 2 });
    const unlimited = new MemoryEventStream({ maxHistory: 0 });
    ring.publish(makeEvent(0));
    ring.publish(makeEvent(1));
    unlimited.publish(makeEvent(0));

    ring.clear();
    unlimited.clear();
    expect(ring.getHistory()).toEqual([]);
    expect(unlimited.getHistory()).toEqual([]);

    ring.publish(makeEvent(2));
    expect(ring.getHistory().map((e) => e.data)).toEqual([{ index: 2 }]);
  });

  it('still delivers every event to subscribers beyond the limit', () => {
    const stream = new MemoryEventStream({ maxHistory: 2 });
    const received: number[] = [];
    stream.subscribe((event) => {
      received.push((event.data as { index: number }).index);
    });

    for (let i = 0; i < 10; i += 1) stream.publish(makeEvent(i));

    expect(received).toHaveLength(10);
    expect(stream.getHistory()).toHaveLength(2);
  });

  it('waitFor can read a retained response but not an evicted one', async () => {
    const stream = new MemoryEventStream({ maxHistory: 1 });
    stream.publish({
      type: 'ask.user.answered',
      run_id: 'r',
      data: { requestId: 'kept', answer: 'ok' },
      ts: 1,
    });

    await expect(stream.waitFor('ask.user.answered', { requestId: 'kept' })).resolves.toMatchObject(
      { requestId: 'kept' },
    );

    stream.publish({
      type: 'ask.user.answered',
      run_id: 'r',
      data: { requestId: 'evicted', answer: 'gone' },
      ts: 2,
    });
    stream.publish(makeEvent(3));

    await expect(
      stream.waitFor('ask.user.answered', { requestId: 'evicted', timeout: 20 }),
    ).rejects.toThrow('Timed out');
  });

  it('keeps memory bounded under a 10k event burst', () => {
    const stream = new MemoryEventStream({ maxHistory: 100 });
    for (let i = 0; i < 10000; i += 1) stream.publish(makeEvent(i));

    const history = stream.getHistory();
    expect(history).toHaveLength(100);
    expect(history[0]?.data).toEqual({ index: 9900 });
    expect(history[99]?.data).toEqual({ index: 9999 });
  });
});
