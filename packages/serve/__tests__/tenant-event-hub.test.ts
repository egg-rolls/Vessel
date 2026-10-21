import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { SeqEvent } from '../src/event-buffer';
import { createTenantEventHub, type TenantEventHubOptions } from '../src/tenant-event-hub';

function event(type = 'run.started', runId = 'run-1', ts = 1): RunEvent {
  return { type, run_id: runId, data: {}, ts };
}

function makeHub(options: Omit<TenantEventHubOptions, 'map'> = {}) {
  return createTenantEventHub({ ...options, map: (input) => input });
}

describe('TenantEventHub', () => {
  it('fans in tenant streams in arrival order with one global sequence', () => {
    const a = new MemoryEventStream();
    const b = new MemoryEventStream();
    const hub = makeHub({
      streams: [
        { tenantId: 'a', stream: a },
        { tenantId: 'b', stream: b },
      ],
    });
    const seen: SeqEvent[] = [];
    hub.subscribeSequenced((item) => seen.push(item));

    a.publish(event('a.1'));
    b.publish(event('b.1'));
    a.publish(event('a.2'));

    expect(seen.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(seen.map((item) => item.event.type)).toEqual(['a.1', 'b.1', 'a.2']);
    expect(seen.map((item) => item.event.tenant_id)).toEqual(['a', 'b', 'a']);
    expect(hub.latestSeq).toBe(3);
    hub.close();
  });

  it('stamps a missing tenant_id without mutating the original event', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub({ streams: [{ tenantId: 'acme', stream }] });
    const original = event();
    const raw: RunEvent[] = [];
    hub.subscribe((item) => raw.push(item));

    stream.publish(original);

    expect(raw[0]?.tenant_id).toBe('acme');
    expect((original as { tenant_id?: string }).tenant_id).toBeUndefined();
    expect(raw[0]).not.toBe(original);
    hub.close();
  });

  it('keeps an explicit tenant_id and applies map only to sequenced output', () => {
    const stream = new MemoryEventStream();
    const hub = createTenantEventHub({
      streams: [{ tenantId: 'acme', stream }],
      map: (input) => ({ ...input, data: { mapped: true } }),
    });
    const raw: RunEvent[] = [];
    const sequenced: SeqEvent[] = [];
    hub.subscribe((item) => raw.push(item));
    hub.subscribeSequenced((item) => sequenced.push(item));

    const original = { ...event(), tenant_id: 'explicit' } as RunEvent;
    stream.publish(original);

    expect(raw[0]?.tenant_id).toBe('explicit');
    expect(raw[0]?.data).toEqual({});
    expect(sequenced[0]?.event.tenant_id).toBe('explicit');
    expect(sequenced[0]?.event.data).toEqual({ mapped: true });
    // map 不得原地修改原事件。
    expect(original.data).toEqual({});
    hub.close();
  });

  it('registers idempotently and rejects a different stream for the same tenant', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub();
    hub.register('acme', stream);
    hub.register('acme', stream);

    const seen: SeqEvent[] = [];
    hub.subscribeSequenced((item) => seen.push(item));
    stream.publish(event());
    expect(seen).toHaveLength(1);
    expect(hub.tenantIds).toEqual(['acme']);

    expect(() => hub.register('acme', new MemoryEventStream())).toThrow('different stream');
    hub.close();
  });

  it('subscribes once when one stream backs several tenants', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub({
      streams: [
        { tenantId: 'a', stream },
        { tenantId: 'b', stream },
      ],
    });
    const seen: SeqEvent[] = [];
    hub.subscribeSequenced((item) => seen.push(item));

    stream.publish(event());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.tenant_id).toBe('a');
    expect(hub.tenantIds).toEqual(['a', 'b']);
    expect(hub.streamFor('b')).toBe(stream);
    hub.close();
  });

  it('stops delivering after unregister', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub();
    const unsubscribe = hub.register('acme', stream);
    const seen: SeqEvent[] = [];
    hub.subscribeSequenced((item) => seen.push(item));

    stream.publish(event('first'));
    unsubscribe();
    stream.publish(event('second'));

    expect(seen.map((item) => item.event.type)).toEqual(['first']);
    expect(hub.streamFor('acme')).toBeUndefined();
    hub.close();
  });

  it('replays since / gap / oldest over a bounded ring', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub({ streams: [{ tenantId: 'a', stream }], maxHistory: 3 });
    for (let index = 1; index <= 5; index += 1) stream.publish(event(`e${index}`));

    expect(hub.latestSeq).toBe(5);
    expect(hub.oldestSeq).toBe(3);
    expect(hub.since(2).map((item) => item.event.type)).toEqual(['e3', 'e4', 'e5']);
    expect(hub.since(4).map((item) => item.event.type)).toEqual(['e5']);
    expect(hub.gapFor(0)).toEqual({ from_seq: 1, to_seq: 2 });
    expect(hub.gapFor(2)).toBeNull();
    hub.close();
  });

  it('exposes no publish method', () => {
    const hub = makeHub();
    expect('publish' in hub).toBe(false);
    hub.close();
  });

  it('isolates subscriber errors', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub({ streams: [{ tenantId: 'a', stream }] });
    const received: RunEvent[] = [];
    hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((item) => received.push(item));
    const sequenced: SeqEvent[] = [];
    hub.subscribeSequenced((item) => sequenced.push(item));

    expect(() => stream.publish(event())).not.toThrow();
    expect(received).toHaveLength(1);
    expect(sequenced).toHaveLength(1);
    hub.close();
  });

  it('closes idempotently and rejects new registrations', () => {
    const stream = new MemoryEventStream();
    const hub = makeHub({ streams: [{ tenantId: 'a', stream }] });
    const seen: SeqEvent[] = [];
    hub.subscribeSequenced((item) => seen.push(item));

    hub.close();
    hub.close();
    stream.publish(event());

    expect(seen).toHaveLength(0);
    expect(hub.streamFor('a')).toBeUndefined();
    expect(() => hub.register('b', new MemoryEventStream())).toThrow('closed');
    expect(() => hub.subscribe(() => {})).toThrow('closed');
  });
});
