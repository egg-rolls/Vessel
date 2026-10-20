import { describe, expect, it } from 'bun:test';
import {
  createHttpRpcClient,
  normalizeConnectUrl,
  parseGatewayFrame,
  RpcClientError,
  type RpcEventNotification,
  type WebSocketLike,
} from '../rpc/index';

class FakeSocket {
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data });
  }

  auth(): Record<string, unknown> {
    return JSON.parse(this.sent[0] ?? '{}') as Record<string, unknown>;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

function makeClient(sockets: FakeSocket[]) {
  return createHttpRpcClient({
    baseUrl: 'https://gateway.example.com:8642',
    token: 'secret',
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    webSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    reconnect: { initialMs: 1, maxMs: 2, helloTimeoutMs: 1000 },
  });
}

describe('parseGatewayFrame (0.6)', () => {
  it('parses hello / event / gap / ping and legacy frames', () => {
    expect(
      parseGatewayFrame(
        JSON.stringify({
          v: 1,
          kind: 'hello',
          node_id: 'n1',
          tenant_id: 't1',
          latest_seq: 7,
        }),
      ),
    ).toEqual({ kind: 'hello', nodeId: 'n1', tenantId: 't1', latestSeq: 7 });

    expect(
      parseGatewayFrame(
        JSON.stringify({
          v: 1,
          kind: 'event',
          seq: 8,
          event: { type: 'run.started', run_id: 'r1', data: {}, ts: 1 },
        }),
      ),
    ).toEqual({
      kind: 'event',
      seq: 8,
      event: { type: 'run.started', run_id: 'r1', data: {}, ts: 1 },
    });

    expect(parseGatewayFrame(JSON.stringify({ v: 1, kind: 'gap', to_seq: 4 }))).toEqual({
      kind: 'gap',
      toSeq: 4,
    });
    expect(parseGatewayFrame(JSON.stringify({ v: 1, kind: 'ping' }))).toEqual({ kind: 'ping' });
    expect(
      parseGatewayFrame(
        JSON.stringify({ method: 'events.event', params: { type: 'run.completed' } }),
      ),
    ).toEqual({
      kind: 'notification',
      notification: { method: 'events.event', params: { type: 'run.completed' } },
    });
    expect(
      parseGatewayFrame(JSON.stringify({ type: 'run.started', run_id: 'r1', data: {}, ts: 1 })),
    ).toMatchObject({ kind: 'notification' });
    expect(parseGatewayFrame('not-json')).toBeUndefined();
  });
});

describe('HttpRpcClient remote connect (0.6 A1)', () => {
  it('enforces https + token for non-loopback and rejects URL components', () => {
    expect(() =>
      createHttpRpcClient({
        baseUrl: 'http://gateway.example.com:8642',
        token: 't',
        subscribe: false,
      }),
    ).toThrow(RpcClientError);

    expect(() =>
      createHttpRpcClient({
        baseUrl: 'https://gateway.example.com:8642',
        token: '',
        subscribe: false,
      }),
    ).toThrow(/requires a token/);

    expect(() =>
      createHttpRpcClient({
        baseUrl: 'https://gateway.example.com/path',
        token: 't',
        subscribe: false,
      }),
    ).toThrow(/must not contain a path/);

    expect(() =>
      createHttpRpcClient({
        baseUrl: 'https://gateway.example.com?token=x',
        token: 't',
        subscribe: false,
      }),
    ).toThrow(/must not contain query or hash/);

    expect(() =>
      createHttpRpcClient({
        baseUrl: 'https://user:pass@gateway.example.com',
        token: 't',
        subscribe: false,
      }),
    ).toThrow(/userinfo/);

    // loopback 明文保持可用（本机开发）。
    expect(() =>
      createHttpRpcClient({ baseUrl: 'http://127.0.0.1:8642', token: '', subscribe: false }),
    ).not.toThrow();

    // P2：ws:// / wss:// 与误传的 /ws 路径归一化为 http(s)。
    expect(() =>
      createHttpRpcClient({
        baseUrl: 'wss://gateway.example.com:8642',
        token: 't',
        subscribe: false,
      }),
    ).not.toThrow();
    expect(() =>
      createHttpRpcClient({
        baseUrl: 'wss://gateway.example.com:8642/ws',
        token: 't',
        subscribe: false,
      }),
    ).not.toThrow();
    expect(() =>
      createHttpRpcClient({ baseUrl: 'ws://127.0.0.1:8642', token: '', subscribe: false }),
    ).not.toThrow();
    expect(normalizeConnectUrl('wss://host:1/ws')).toBe('https://host:1');
  });
});

describe('HttpRpcClient WS reconnect (0.6 A2)', () => {
  it('auth carries since, pong replies, and seq rollback resets since', async () => {
    const sockets: FakeSocket[] = [];
    const client = makeClient(sockets);
    const received: RpcEventNotification[] = [];
    const unsubscribe = client.subscribe((notification) => received.push(notification));

    expect(sockets).toHaveLength(1);
    sockets[0]?.emit('open');
    expect(sockets[0]?.auth()).toMatchObject({ kind: 'auth', token: 'secret' });

    sockets[0]?.emitMessage(JSON.stringify({ v: 1, kind: 'hello', latest_seq: 10 }));
    sockets[0]?.emitMessage(
      JSON.stringify({
        v: 1,
        kind: 'event',
        seq: 10,
        event: { type: 'run.started', run_id: 'r1', data: {}, ts: 1 },
      }),
    );
    sockets[0]?.emitMessage(JSON.stringify({ v: 1, kind: 'ping' }));
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? '{}')).toEqual({ v: 1, kind: 'pong' });

    // 断线 → 重连带 since=10。
    sockets[0]?.emit('close');
    await waitFor(() => sockets.length === 2);
    sockets[1]?.emit('open');
    expect(sockets[1]?.auth()).toMatchObject({ kind: 'auth', since: 10 });

    // gateway 重启：latest_seq 回退 → 重置并从 0 重连。
    sockets[1]?.emitMessage(JSON.stringify({ v: 1, kind: 'hello', latest_seq: 3 }));
    await waitFor(() => sockets.length === 3);
    sockets[2]?.emit('open');
    expect(sockets[2]?.auth().since).toBeUndefined();

    // gap → 以 to_seq 重连。
    sockets[2]?.emitMessage(JSON.stringify({ v: 1, kind: 'gap', to_seq: 20 }));
    await waitFor(() => sockets.length === 4);
    sockets[3]?.emit('open');
    expect(sockets[3]?.auth()).toMatchObject({ since: 20 });

    expect(received).toHaveLength(1);
    unsubscribe();
    await client.close();
  });
});
