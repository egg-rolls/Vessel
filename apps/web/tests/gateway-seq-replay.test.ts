import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayClient } from '../src/gateway/client';
import { planHelloSeq } from '../src/gateway/seq-replay';
import { EventStore } from '../src/state/event-store';

function helloFrame(latestSeq: number): Record<string, unknown> {
  return {
    v: 1,
    kind: 'hello',
    node_id: 'node-1',
    ts: 1,
    protocol: { version: 'vessel.gateway/1', features: [] },
    node: { node_id: 'node-1', name: 'node-1' },
    from_seq: 1,
    latest_seq: latestSeq,
  };
}

function event(
  seq: number,
  type = 'run.started',
): {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
} {
  return { type, run_id: 'run-1', data: {}, ts: seq };
}

describe('planHelloSeq', () => {
  test('replays from zero when the gateway seq goes backwards', () => {
    expect(planHelloSeq(3, 10)).toEqual({
      replay: true,
      since: 0,
      resetTo: 0,
      notice: 'gateway 已重启，事件序号已回退，正在从头重放',
    });
  });

  test('keeps the current connection when the cursor is caught up or ahead', () => {
    expect(planHelloSeq(10, 10)).toEqual({ replay: false, since: 10, resetTo: null, notice: null });
    expect(planHelloSeq(0, 0).replay).toBe(false);
  });
});

describe('seq rollback timeline', () => {
  test('replays the complete 1..latest_seq range after a rollback', () => {
    const store = new EventStore(0);
    for (let seq = 1; seq <= 10; seq += 1) store.push(event(seq), { seq });
    expect(store.currentSeq).toBe(10);

    const plan = planHelloSeq(3, store.currentSeq);
    expect(plan.replay).toBe(true);
    store.reset(plan.resetTo ?? 0);

    const accepted: number[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      if (store.push(event(seq), { seq })) accepted.push(seq);
    }
    store.flush();

    expect(accepted).toEqual([1, 2, 3]);
    expect(store.getSnapshot().entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(store.getSnapshot().lastSeq).toBe(3);
  });

  test('advancing the cursor to latest_seq drops the replay (old behavior)', () => {
    const store = new EventStore(0);
    for (let seq = 1; seq <= 10; seq += 1) store.push(event(seq), { seq });

    // 旧实现：reset(latest_seq) 后继续同一连接，重放的 1..3 全被当作重复。
    store.reset(3);
    const accepted: number[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      if (store.push(event(seq), { seq })) accepted.push(seq);
    }
    expect(accepted).toEqual([]);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  message(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  private emit(type: string, payload: unknown): void {
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback(payload);
  }
}

describe('GatewayClient.restart', () => {
  const original = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = original;
  });

  test('forces a new connection with since=0 even while open', async () => {
    const client = new GatewayClient('http://gateway.test');
    const first = client.connect('token', 7);
    const initial = FakeWebSocket.instances[0];
    if (!initial) throw new Error('missing first socket');
    initial.open();
    expect(JSON.parse(initial.sent[0] ?? '{}')).toMatchObject({ kind: 'auth', since: 7 });
    initial.message(helloFrame(3));
    await first;
    expect(client.connectionState).toBe('open');

    const replayed = client.restart('token', 0, 'tenant-b');
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error('missing replay socket');
    expect(second.url).toBe('ws://gateway.test/v1/events?since=0');
    second.open();
    expect(JSON.parse(second.sent[0] ?? '{}')).toMatchObject({
      kind: 'auth',
      since: 0,
      tenant_id: 'tenant-b',
    });
    second.message(helloFrame(3));
    await replayed;
    expect(client.connectionState).toBe('open');
  });
});
