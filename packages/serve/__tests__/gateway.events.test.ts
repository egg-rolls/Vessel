import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemorySessionBackend } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { createGateway, createRuntime, TestWs } from './helpers';

describe('gateway events / protocol', () => {
  const gateways: Gateway[] = [];
  const clients: TestWs[] = [];

  const track = (gw: Gateway): Gateway => {
    gateways.push(gw);
    return gw;
  };

  const connect = async (gw: Gateway, opts?: { token?: string | null; since?: number }) => {
    const client = await TestWs.connect(gw, opts);
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('authenticates with a first frame and sends hello before replay', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events }));
    events.publish({ type: 'demo.event', run_id: 'r1', data: { n: 1 }, ts: Date.now() });

    const client = await connect(gw);
    const hello = await client.next((frame) => frame.kind === 'hello');
    expect(hello.kind).toBe('hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.protocol.version).toBe(1);
    expect(hello.node.node_id).toBe(gw.nodeId);
    expect(hello.latest_seq).toBe(1);

    const event = await client.next(
      (frame) => frame.kind === 'event' && frame.event.type === 'demo.event',
    );
    expect(event.kind).toBe('event');
    if (event.kind !== 'event') throw new Error('expected event');
    expect(event.seq).toBe(1);
    expect(event.node_id).toBe(gw.nodeId);
  });

  it('closes the socket on a bad auth token', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));
    const client = await connect(gw, { token: 'wrong-token' });
    expect(await client.closed()).toBe(4401);
  });

  it('closes unauthenticated sockets after the auth timeout', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream(), authTimeoutMs: 100 }));
    const client = await connect(gw, { token: null });
    expect(await client.closed()).toBe(4401);
  });

  it('reports from_seq=0 and latest_seq=0 on an empty buffer', async () => {
    const gw = track(createGateway({ events: new MemoryEventStream() }));
    const client = await connect(gw);
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.from_seq).toBe(0);
    expect(hello.latest_seq).toBe(0);
  });

  it('reports the next expected seq when the client is caught up', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events, maxHistory: 10 }));
    for (let i = 1; i <= 3; i++) {
      events.publish({ type: 'demo.event', run_id: 'r1', data: { n: i }, ts: Date.now() });
    }
    const client = await connect(gw, { since: 3 });
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.from_seq).toBe(4);
    expect(hello.latest_seq).toBe(3);
  });

  it('replays only events after since', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events, maxHistory: 10 }));
    for (let i = 1; i <= 3; i++) {
      events.publish({ type: 'demo.event', run_id: 'r1', data: { n: i }, ts: Date.now() });
    }

    const client = await connect(gw, { since: 2 });
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.from_seq).toBe(3);
    expect(hello.latest_seq).toBe(3);

    const event = await client.next((frame) => frame.kind === 'event');
    if (event.kind !== 'event') throw new Error('expected event');
    expect(event.seq).toBe(3);
    expect((event.event.data as { n: number }).n).toBe(3);
  });

  it('emits a gap frame when history was truncated', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events, maxHistory: 2 }));
    for (let i = 1; i <= 5; i++) {
      events.publish({ type: 'demo.event', run_id: 'r1', data: { n: i }, ts: Date.now() });
    }

    const client = await connect(gw, { since: 0 });
    const hello = await client.next((frame) => frame.kind === 'hello');
    if (hello.kind !== 'hello') throw new Error('expected hello');
    expect(hello.from_seq).toBe(4);
    expect(hello.latest_seq).toBe(5);

    const gap = await client.next((frame) => frame.kind === 'gap');
    if (gap.kind !== 'gap') throw new Error('expected gap');
    expect(gap.from_seq).toBe(1);
    expect(gap.to_seq).toBe(3);

    const first = await client.next((frame) => frame.kind === 'event');
    const second = await client.next((frame) => frame.kind === 'event');
    if (first.kind !== 'event' || second.kind !== 'event') throw new Error('expected events');
    expect([first.seq, second.seq]).toEqual([4, 5]);
  });

  it('fans out identical seq to multiple clients', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events }));
    const a = await connect(gw);
    const b = await connect(gw);
    await a.next((frame) => frame.kind === 'hello');
    await b.next((frame) => frame.kind === 'hello');

    events.publish({ type: 'demo.event', run_id: 'r1', data: { n: 1 }, ts: Date.now() });
    const frameA = await a.next((frame) => frame.kind === 'event');
    const frameB = await b.next((frame) => frame.kind === 'event');
    if (frameA.kind !== 'event' || frameB.kind !== 'event') throw new Error('expected events');
    expect(frameA.seq).toBe(frameB.seq);
    expect(frameA.event.run_id).toBe('r1');
  });

  it('serves request/response methods over WS', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = track(createGateway({ events, runtime, session: new MemorySessionBackend() }));
    const client = await connect(gw);
    await client.next((frame) => frame.kind === 'hello');

    const sessions = (await client.request('sessions.list')) as { sessions: unknown[] };
    expect(sessions.sessions).toBeArray();

    const tools = (await client.request('tools.list')) as { tools: unknown[] };
    expect(tools.tools).toBeArray();

    const submitted = (await client.request('run.submit', { input: 'Hello' })) as {
      run_id: string;
    };
    expect(typeof submitted.run_id).toBe('string');

    const status = (await client.request('run.get', { run_id: submitted.run_id })) as {
      run_id: string;
    };
    expect(status.run_id).toBe(submitted.run_id);
  });

  it('returns method_not_allowed for unknown and team methods', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events }));
    const client = await connect(gw);
    await client.next((frame) => frame.kind === 'hello');

    const id1 = 'unknown-1';
    client.ws.send(
      JSON.stringify({ v: 1, kind: 'req', id: id1, method: 'no.such.method', params: {} }),
    );
    const res1 = await client.next((frame) => frame.kind === 'res' && frame.id === id1);
    if (res1.kind !== 'res') throw new Error('expected res');
    expect(res1.ok).toBe(false);
    if (res1.ok) throw new Error('expected error');
    expect(res1.error.code).toBe('method_not_allowed');

    const id2 = 'team-1';
    client.ws.send(
      JSON.stringify({ v: 1, kind: 'req', id: id2, method: 'team.nodes', params: {} }),
    );
    const res2 = await client.next((frame) => frame.kind === 'res' && frame.id === id2);
    if (res2.kind !== 'res' || res2.ok) throw new Error('expected team error');
    expect(res2.error.code).toBe('method_not_allowed');
  });

  it('streams the same frames over SSE', async () => {
    const events = new MemoryEventStream();
    const gw = track(createGateway({ events }));
    events.publish({ type: 'demo.event', run_id: 'r1', data: { n: 1 }, ts: Date.now() });

    const controller = new AbortController();
    const res = await fetch(`${gw.url}/v1/events?token=${gw.token}&since=0`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');

    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('demo.event')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();
    controller.abort();

    expect(text).toContain('"kind":"hello"');
    expect(text).toContain('"kind":"event"');
    expect(text).toContain('demo.event');
    expect(text).toContain('"seq":1');
  });

  it('keeps SSE alive past the idle timeout and emits pings', async () => {
    // 余量要足够大：全量并发下事件循环可能被别的测试占用，心跳间隔被推迟。
    // idleTimeout=5s、heartbeat=100ms、观测 6s —— 共 50 个心跳周期，避免偶发 ECONNRESET。
    const gw = track(
      createGateway({
        events: new MemoryEventStream(),
        idleTimeout: 5,
        heartbeatMs: 100,
      }),
    );
    const res = await fetch(`${gw.url}/v1/events?token=${gw.token}`);
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let text = '';
    let closed = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) {
        closed = true;
        break;
      }
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(closed).toBe(false);
    expect(text).toContain(': ping');
  }, 15_000);

  it('marks frames with job_id after run.started', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = track(createGateway({ events, runtime }));
    const client = await connect(gw);
    await client.next((frame) => frame.kind === 'hello');

    const res = await fetch(`${gw.url}/v1/runs?token=${gw.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    const eventFrame = await client.next(
      (frame) => frame.kind === 'event' && frame.event.type === 'run.started',
    );
    if (eventFrame.kind !== 'event') throw new Error('expected event');
    expect(eventFrame.job_id).toBe(run_id);
    await client.nextEvent('run.completed');
  });
});
