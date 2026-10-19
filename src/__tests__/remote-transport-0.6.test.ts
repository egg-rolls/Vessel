import { describe, expect, it } from 'bun:test';
import type { TransportNodeConfig } from '../../packages/config/src/index';
import type { RunEvent } from '../../packages/core/src/index';
import { NodeRegistry } from '../node-registry';
import { RemoteTransport } from '../remote-transport';
import type { WebSocketLike } from '../rpc/index';

type FetchLike = typeof fetch;
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetch(handler: Handler): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

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

const NODES: TransportNodeConfig[] = [
  { id: 'node-b', url: 'http://127.0.0.1:9001', token: 'tok-b' },
  { id: 'node-c', url: 'https://node-c.example.com', token: 'tok-c' },
];

async function makeTransport(options: {
  fetchImpl: FetchLike;
  onEvent?: (event: RunEvent) => void;
  webSocket?: (url: string) => WebSocketLike;
  requestTimeoutMs?: number;
  nodes?: TransportNodeConfig[];
  env?: Record<string, string | undefined>;
}): Promise<{ transport: RemoteTransport; registry: NodeRegistry }> {
  const registry = await NodeRegistry.create(options.nodes ?? NODES, {
    env: options.env ?? {},
    fetch: options.fetchImpl,
    heartbeatMs: 0,
  });
  const transport = new RemoteTransport({
    nodeId: 'node-a',
    registry,
    fetch: options.fetchImpl,
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.webSocket ? { webSocket: options.webSocket } : {}),
    eventReconnect: { initialMs: 1, maxMs: 2, helloTimeoutMs: 1000 },
  });
  return { transport, registry };
}

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('RemoteTransport.request (0.6 B3 协议映射)', () => {
  it('maps team.spawn/inbox/status/status.list to gateway wire endpoints', async () => {
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (url === 'http://127.0.0.1:9001/v1/team/agents') {
        if (init.method === 'POST') {
          return jsonResponse(
            { protocol: 1, agent: { id: 'a1', state: 'idle', tool_names: [] } },
            201,
          );
        }
        return jsonResponse({ protocol: 1, agents: [{ id: 'a1', state: 'idle', tool_names: [] }] });
      }
      if (url === 'http://127.0.0.1:9001/v1/team/agents/a1') {
        return jsonResponse({
          protocol: 1,
          agent: { id: 'a1', state: 'running', tool_names: ['bash'] },
        });
      }
      if (url.startsWith('http://127.0.0.1:9001/v1/team/inbox')) {
        return jsonResponse({ protocol: 1, agent_id: 'a1', messages: [], cursor: 'c2' });
      }
      return jsonResponse({ protocol: 1, ok: true }, 201);
    });
    const { transport } = await makeTransport({ fetchImpl });

    const spawned = await transport.request<{ agent: { id: string } }>('node-b', {
      requestId: 'req-1',
      method: 'team.spawn',
      params: { name: 'worker', model: 'm1', systemPrompt: 'be nice' },
    });
    expect(spawned.agent.id).toBe('a1');
    const spawnCall = calls[0];
    expect(spawnCall?.url).toBe('http://127.0.0.1:9001/v1/team/agents');
    expect(spawnCall?.init.method).toBe('POST');
    expect(headersOf(spawnCall ?? { url: '', init: {} }).Authorization).toBe('Bearer tok-b');
    expect(headersOf(spawnCall ?? { url: '', init: {} })['X-Vessel-Request-Id']).toBe('req-1');
    expect(JSON.parse(String(spawnCall?.init.body))).toEqual({
      request_id: 'req-1',
      name: 'worker',
      model: 'm1',
      system_prompt: 'be nice',
    });

    const inbox = await transport.request<{ cursor: string }>('node-b', {
      method: 'team.inbox',
      params: { agentId: 'a1', cursor: 'c1' },
    });
    expect(inbox.cursor).toBe('c2');
    expect(calls[1]?.url).toBe('http://127.0.0.1:9001/v1/team/inbox?agent_id=a1&cursor=c1');
    expect(calls[1]?.init.method).toBe('GET');

    const status = await transport.request<{ agent: { state: string } }>('node-b', {
      method: 'team.status',
      params: { agentId: 'a1' },
    });
    expect(status.agent.state).toBe('running');
    expect(calls[2]?.url).toBe('http://127.0.0.1:9001/v1/team/agents/a1');

    const list = await transport.request<{ agents: unknown[] }>('node-b', {
      method: 'team.status.list',
    });
    expect(list.agents).toHaveLength(1);

    // 第二个节点走各自 URL/token（双节点）。
    await transport.request('node-c', { method: 'team.status.list' });
    const remoteCall = calls.at(-1);
    expect(remoteCall?.url).toBe('https://node-c.example.com/v1/team/agents');
    expect(headersOf(remoteCall ?? { url: '', init: {} }).Authorization).toBe('Bearer tok-c');

    await transport.close();
  });

  it('rejects unknown node/method and requires agentId', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const { transport } = await makeTransport({ fetchImpl });

    await expect(transport.request('node-z', { method: 'team.status.list' })).rejects.toMatchObject(
      { code: 'peer_not_found' },
    );
    await expect(transport.request('node-b', { method: 'team.unknown' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      transport.request('node-b', { method: 'team.status', params: {} }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await transport.close();
  });
});

describe('RemoteTransport.send (0.6 B1)', () => {
  it('routes remote targets over HTTP and local targets in-process', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ protocol: 1, ok: true }, 202));
    const { transport } = await makeTransport({ fetchImpl });
    const local: string[] = [];
    transport.receive((message) => {
      local.push(message.id);
    });

    await transport.send({
      id: 'm1',
      from: 'node-a:owner',
      to: 'node-b:worker',
      kind: 'task',
      content: 'hi',
      ts: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9001/v1/team/messages');
    expect(headersOf(calls[0] ?? { url: '', init: {} }).Authorization).toBe('Bearer tok-b');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      protocol: 1,
      node_id: 'node-a',
      message: { id: 'm1', from: 'node-a:owner', to: 'node-b:worker', kind: 'task' },
    });

    await transport.send({
      id: 'm2',
      from: 'node-a:owner',
      to: 'worker',
      kind: 'message',
      content: 'local',
      ts: 2,
    });
    expect(calls).toHaveLength(1);
    expect(local).toEqual(['m2']);

    await transport.send({
      id: 'm3',
      from: 'node-a:owner',
      to: '*',
      kind: 'message',
      content: 'broadcast',
      ts: 3,
    });
    expect(calls).toHaveLength(1);
    expect(local).toEqual(['m2', 'm3']);

    await expect(
      transport.send({
        id: 'm4',
        from: 'node-a:owner',
        to: 'node-z:worker',
        kind: 'task',
        content: 'x',
        ts: 4,
      }),
    ).rejects.toMatchObject({ code: 'peer_not_found' });

    await transport.close();
  });

  it('deduplicates inbound messages by id', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const { transport } = await makeTransport({ fetchImpl });
    let count = 0;
    transport.receive(() => {
      count += 1;
    });

    const message = {
      id: 'dup-1',
      from: 'node-b:worker',
      to: 'owner',
      kind: 'task' as const,
      content: 'x',
      ts: 1,
    };
    expect(await transport.deliver(message)).toBe(true);
    expect(await transport.deliver(message)).toBe(false);
    expect(count).toBe(1);

    await transport.close();
    await expect(transport.deliver({ ...message, id: 'dup-2' })).rejects.toMatchObject({
      code: 'transport_closed',
    });
  });
});

describe('RemoteTransport error normalization (0.6)', () => {
  it('maps HTTP status and gateway codes to stable transport codes', async () => {
    const cases: Array<{ handler: Handler; code: string }> = [
      { handler: () => jsonResponse({ error: { message: 'no' } }, 401), code: 'unauthorized' },
      {
        handler: () => jsonResponse({ error: { code: 'unsupported_protocol', message: 'v' } }, 426),
        code: 'unsupported_protocol',
      },
      {
        handler: () =>
          jsonResponse({ error: { code: 'agent_not_found', message: 'missing' } }, 404),
        code: 'agent_not_found',
      },
      {
        handler: () => jsonResponse({ error: { code: 'no_spawn', message: 'nope' } }, 400),
        code: 'no_spawn',
      },
      {
        handler: () => jsonResponse({ error: { code: 'invalid_request', message: 'bad' } }, 400),
        code: 'invalid_request',
      },
    ];

    for (const testCase of cases) {
      const { fetchImpl } = makeFetch(testCase.handler);
      const { transport } = await makeTransport({ fetchImpl });
      try {
        await transport.request('node-b', { method: 'team.status.list' });
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toMatchObject({ code: testCase.code });
      }
      await transport.close();
    }
  });

  it('maps network failures to peer_unreachable and aborts to timeout', async () => {
    const unreachable = makeFetch(() => {
      throw new TypeError('connection refused');
    });
    const first = await makeTransport({ fetchImpl: unreachable.fetchImpl });
    await expect(
      first.transport.request('node-b', { method: 'team.status.list' }),
    ).rejects.toMatchObject({ code: 'peer_unreachable' });
    await first.transport.close();

    const hanging = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const second = await makeTransport({ fetchImpl: hanging.fetchImpl, requestTimeoutMs: 5 });
    await expect(
      second.transport.request('node-b', { method: 'team.status.list' }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await second.transport.close();
  });
});

describe('RemoteTransport B4 event fan-out (0.6)', () => {
  it('subscribes both nodes, dedupes (node_id, seq), reconnects with since', async () => {
    const sockets: FakeSocket[] = [];
    const events: RunEvent[] = [];
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const { transport } = await makeTransport({
      fetchImpl,
      onEvent: (event) => events.push(event),
      webSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
    });

    transport.start();
    expect(sockets).toHaveLength(2);
    const bSockets = () => sockets.filter((socket) => socket.url.includes('127.0.0.1:9001'));
    const cSocket = sockets.find((socket) => socket.url.startsWith('wss://node-c.example.com'));
    expect(cSocket?.url).toBe('wss://node-c.example.com/v1/events');

    const first = bSockets()[0];
    first?.emit('open');
    expect(first?.auth()).toMatchObject({ kind: 'auth', token: 'tok-b' });
    expect(first?.auth().since).toBeUndefined();

    first?.emitMessage(JSON.stringify({ kind: 'hello', latest_seq: 5 }));
    first?.emitMessage(
      JSON.stringify({
        kind: 'event',
        node_id: 'node-b',
        seq: 6,
        event: { type: 'agent.started', run_id: 'r1', data: {}, ts: 1 },
      }),
    );
    await waitFor(() => events.length === 1);
    expect(events[0]?.node_id).toBe('node-b');
    expect(events[0]?.type).toBe('agent.started');

    // 同一 (node_id, seq) 去重。
    first?.emitMessage(
      JSON.stringify({
        kind: 'event',
        node_id: 'node-b',
        seq: 6,
        event: { type: 'agent.started', run_id: 'r1', data: {}, ts: 1 },
      }),
    );
    expect(events).toHaveLength(1);

    // 断线 → 重连 auth 带 since=6。
    first?.emit('close');
    await waitFor(() => bSockets().length === 2);
    const second = bSockets()[1];
    second?.emit('open');
    expect(second?.auth()).toMatchObject({ kind: 'auth', token: 'tok-b', since: 6 });

    // gateway 重启：latest_seq 回退 → 清空去重键并从 0 重连。
    second?.emitMessage(JSON.stringify({ kind: 'hello', latest_seq: 2 }));
    await waitFor(() => bSockets().length === 3);
    const third = bSockets()[2];
    third?.emit('open');
    expect(third?.auth().since).toBeUndefined();

    // 重启后 seq 复用（6）不应被旧去重键吞掉。
    third?.emitMessage(
      JSON.stringify({
        kind: 'event',
        node_id: 'node-b',
        seq: 6,
        event: { type: 'agent.started', run_id: 'r1-restarted', data: {}, ts: 2 },
      }),
    );
    await waitFor(() => events.length === 2);
    expect(events[1]?.run_id).toBe('r1-restarted');

    // gap → 以 to_seq 立即重连续放。
    third?.emitMessage(JSON.stringify({ kind: 'gap', to_seq: 20 }));
    await waitFor(() => bSockets().length === 4);
    const fourth = bSockets()[3];
    fourth?.emit('open');
    expect(fourth?.auth()).toMatchObject({ kind: 'auth', since: 20 });
    fourth?.emitMessage(JSON.stringify({ kind: 'ping' }));
    expect(JSON.parse(fourth?.sent.at(-1) ?? '{}')).toEqual({ v: 1, kind: 'pong' });

    // 第二个节点使用自己的 token；无 seq 的帧不做去重，逐条投递。
    cSocket?.emit('open');
    expect(cSocket?.auth()).toMatchObject({ kind: 'auth', token: 'tok-c' });
    const noSeq = JSON.stringify({
      kind: 'event',
      node_id: 'node-c',
      event: { type: 'agent.updated', run_id: 'r2', data: {}, ts: 1 },
    });
    cSocket?.emitMessage(noSeq);
    cSocket?.emitMessage(noSeq);
    await waitFor(() => events.length === 4);
    expect(events.filter((event) => event.run_id === 'r2')).toHaveLength(2);

    await transport.close();
    expect(fourth?.closed).toBe(true);
  });
});

describe('NodeRegistry (0.6 B2)', () => {
  it('resolves token_env/CA and probes agents with /health fallback', async () => {
    let agentsOk = true;
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.endsWith('/v1/team/agents') && agentsOk) {
        return jsonResponse({ agents: [{ id: 'a1', state: 'idle', tool_names: ['bash'] }] });
      }
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({ error: { code: 'no_host', message: 'off' } }, 400);
    });
    const registry = await NodeRegistry.create(
      [{ id: 'node-b', url: 'http://127.0.0.1:9001', tokenEnv: 'NODE_B_TOKEN', caFile: 'ca.pem' }],
      {
        env: { NODE_B_TOKEN: 'tok-env' },
        fetch: fetchImpl,
        heartbeatMs: 0,
        readFile: async () => '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
      },
    );

    expect(registry.get('node-b')?.token).toBe('tok-env');
    expect(registry.get('node-b')?.ca).toContain('BEGIN CERTIFICATE');

    await registry.refresh();
    expect(registry.peers()[0]).toMatchObject({ nodeId: 'node-b', status: 'healthy' });
    expect(registry.peers()[0]?.agents[0]?.toolNames).toEqual(['bash']);
    expect(headersOf(calls[0] ?? { url: '', init: {} }).Authorization).toBe('Bearer tok-env');

    // agents 端点失败 → /health 兜底（状态仍 healthy，agents 保持上一次）。
    agentsOk = false;
    await registry.refresh();
    expect(registry.peers()[0]?.status).toBe('healthy');
    expect(calls.some((call) => call.url.endsWith('/health'))).toBe(true);

    registry.stop();
  });

  it('rejects duplicate ids / non-loopback http / missing remote token', async () => {
    await expect(
      NodeRegistry.create(
        [
          { id: 'dup', url: 'http://127.0.0.1:1', token: 't' },
          { id: 'dup', url: 'http://127.0.0.1:2', token: 't' },
        ],
        { heartbeatMs: 0 },
      ),
    ).rejects.toThrow(/duplicate/);

    await expect(
      NodeRegistry.create([{ id: 'bad', url: 'http://remote.example.com', token: 't' }], {
        heartbeatMs: 0,
      }),
    ).rejects.toThrow(/https/);

    await expect(
      NodeRegistry.create([{ id: 'bad', url: 'https://remote.example.com' }], {
        heartbeatMs: 0,
        env: {},
      }),
    ).rejects.toThrow(/requires a token/);
  });
});
