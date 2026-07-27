import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '../src/events/event-stream';
import { EventType } from '../src/types/event';

describe('MemoryEventStream', () => {
  let eventStream: MemoryEventStream;

  beforeEach(() => {
    eventStream = new MemoryEventStream();
  });

  it('should subscribe and publish events', () => {
    const events: unknown[] = [];
    const unsubscribe = eventStream.subscribe((event) => {
      events.push(event);
    });

    const testEvent = {
      type: EventType.RunStarted,
      run_id: 'test-run',
      data: { run_id: 'test-run', input: 'test' },
      ts: Date.now(),
    };

    eventStream.publish(testEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(testEvent);

    unsubscribe();
  });

  it('should unsubscribe correctly', () => {
    const events: unknown[] = [];
    const unsubscribe = eventStream.subscribe((event) => {
      events.push(event);
    });

    unsubscribe();

    const testEvent = {
      type: EventType.RunStarted,
      run_id: 'test-run',
      data: { run_id: 'test-run', input: 'test' },
      ts: Date.now(),
    };

    eventStream.publish(testEvent);

    expect(events).toHaveLength(0);
  });

  it('should store history', () => {
    const testEvent = {
      type: EventType.RunStarted,
      run_id: 'test-run',
      data: { run_id: 'test-run', input: 'test' },
      ts: Date.now(),
    };

    eventStream.publish(testEvent);

    const history = eventStream.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(testEvent);
  });

  it('should filter history by run_id', () => {
    const event1 = {
      type: EventType.RunStarted,
      run_id: 'run-1',
      data: { run_id: 'run-1', input: 'test1' },
      ts: Date.now(),
    };

    const event2 = {
      type: EventType.RunStarted,
      run_id: 'run-2',
      data: { run_id: 'run-2', input: 'test2' },
      ts: Date.now(),
    };

    eventStream.publish(event1);
    eventStream.publish(event2);

    const history = eventStream.getHistory('run-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(event1);
  });

  it('should clear history', () => {
    const testEvent = {
      type: EventType.RunStarted,
      run_id: 'test-run',
      data: { run_id: 'test-run', input: 'test' },
      ts: Date.now(),
    };

    eventStream.publish(testEvent);
    expect(eventStream.getHistory()).toHaveLength(1);

    eventStream.clear();
    expect(eventStream.getHistory()).toHaveLength(0);
  });

  it('should report subscriber count', () => {
    expect(eventStream.subscriberCount).toBe(0);

    const unsubscribe1 = eventStream.subscribe(() => {});
    expect(eventStream.subscriberCount).toBe(1);

    const unsubscribe2 = eventStream.subscribe(() => {});
    expect(eventStream.subscriberCount).toBe(2);

    unsubscribe1();
    expect(eventStream.subscriberCount).toBe(1);

    unsubscribe2();
    expect(eventStream.subscriberCount).toBe(0);
  });
});
