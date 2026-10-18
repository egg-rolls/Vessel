import { describe, expect, it } from 'bun:test';
import type { WebSocketLike } from '../rpc/http-client';
import type { RpcEventNotification, RpcRequest, RpcResponse } from '../rpc/index';
import { createHttpRpcClient, createLocalRpcClient, RpcClientError } from '../rpc/index';
import { resolveGatewayAuth, safeTokenEqual } from '../serve-auth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LocalRpcClient (0.5)', () => {
  it('构造信封、回显 id、返回 result', async () => {
    let seen: RpcRequest | undefined;
    const client = createLocalRpcClient({
      dispatch: async (request) => {
        seen = request;
        return { v: 1, id: request.id, ok: true, result: { echoed: request.method } };
      },
    });

    const result = await client.request<{ echoed: string }>('events.list', { run_id: 'r1' });

    expect(result).toEqual({ echoed: 'events.list' });
    expect(seen?.v).toBe(1);
    expect(typeof seen?.id).toBe('string');
    expect(seen?.method).toBe('events.list');
    expect(seen?.params).toEqual({ run_id: 'r1' });
  });

  it('ok:false → RpcClientError；id 不匹配 / 信封非法 → internal', async () => {
    const failing = createLocalRpcClient({
      dispatch: async (request) =>
        ({
          v: 1,
          id: request.id,
          ok: false,
          error: { code: 'tenant_locked', message: 'locked', details: { tenant: 'work' } },
        }) satisfies RpcResponse,
    });

    try {
      await failing.request('sessions.list');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcClientError);
      const rpcError = error as RpcClientError;
      expect(rpcError.code).toBe('tenant_locked');
      expect(rpcError.details).toEqual({ tenant: 'work' });
    }

    const wrongId = createLocalRpcClient({
      dispatch: async () => ({ v: 1, id: 'other', ok: true, result: 1 }),
    });
    await expect(wrongId.request('x')).rejects.toMatchObject({ code: 'internal' });

    const invalid = createLocalRpcClient({
      dispatch: async () => ({ nope: true }) as unknown as RpcResponse,
    });
    await expect(invalid.request('x')).rejects.toMatchObject({ code: 'internal' });
  });

  it('subscribe 委托 onEvent；无事件源返回 no-op', () => {
    let registered: ((notification: RpcEventNotification) => void) | undefined;
    const client = createLocalRpcClient({
      dispatch: async () => ({ v: 1, id: 'x', ok: true, result: null }),
      onEvent: (handler) => {
        registered = handler;
        return () => {
          registered = undefined;
        };
      },
    });

    const received: RpcEventNotification[] = [];
    const unsubscribe = client.subscribe((notification) => received.push(notification));
    registered?.({ method: 'events.event', params: { type: 'run.started' } });
    expect(received).toHaveLength(1);
    unsubscribe();
    expect(registered).toBeUndefined();

    const noEvent = createLocalRpcClient({
      dispatch: async () => ({ v: 1, id: 'x', ok: true, result: null }),
    });
    expect(noEvent.subscribe(() => {})).toBeFunction();
  });
});

describe('HttpRpcClient (0.5)', () => {
  function makeFetch(responder: (request: RpcRequest, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as RpcRequest;
      calls.push({ url: String(input), init: init ?? {} });
      return responder(request, init ?? {});
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('POST /v1/rpc + Bearer token + 成功解包', async () => {
    const { fetchImpl, calls } = makeFetch((request) =>
      jsonResponse({ v: 1, id: request.id, ok: true, result: { ok: true } }),
    );
    const client = createHttpRpcClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 'secret-token',
      fetch: fetchImpl,
      subscribe: false,
    });

    const result = await client.request('events.list', { run_id: 'r1' });

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8642/v1/rpc');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('ok:false（HTTP 200）抛对应错误码', async () => {
    const { fetchImpl } = makeFetch((request) =>
      jsonResponse({
        v: 1,
        id: request.id,
        ok: false,
        error: { code: 'quota_exceeded', message: 'too much', details: { limit: 1 } },
      }),
    );
    const client = createHttpRpcClient({
      baseUrl: 'http://127.0.0.1:8642',
      token: 't',
      fetch: fetchImpl,
      subscribe: false,
    });

    await expect(client.request('runs.start')).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: 'too much',
      details: { limit: 1 },
    });
  });

  it('HTTP 状态映射 400/401/403/413/500', async () => {
    const cases: Array<{ status: number; code: string; details?: unknown }> = [
      { status: 400, code: 'invalid_params' },
      { status: 401, code: 'unauthorized' },
      { status: 403, code: 'forbidden' },
      { status: 413, code: 'invalid_params', details: { status: 413 } },
      { status: 500, code: 'internal' },
    ];

    for (const testCase of cases) {
      const { fetchImpl } = makeFetch(() =>
        jsonResponse({ error: { message: 'boom' } }, testCase.status),
      );
      const client = createHttpRpcClient({
        baseUrl: 'http://localhost:8642',
        token: 't',
        fetch: fetchImpl,
        subscribe: false,
      });

      try {
        await client.request('x');
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcClientError);
        const rpcError = error as RpcClientError;
        expect(rpcError.code).toBe(testCase.code as RpcClientError['code']);
        expect(rpcError.httpStatus).toBe(testCase.status);
        if (testCase.details !== undefined) expect(rpcError.details).toEqual(testCase.details);
      }
    }
  });

  it('id 不匹配 / 非 JSON / 非回环 URL 报错', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ v: 1, id: 'other', ok: true, result: 1 }));
    const mismatch = createHttpRpcClient({
      baseUrl: 'http://127.0.0.1:1',
      token: '',
      fetch: fetchImpl,
      subscribe: false,
    });
    await expect(mismatch.request('x')).rejects.toMatchObject({ code: 'internal' });

    const nonJson = createHttpRpcClient({
      baseUrl: 'http://127.0.0.1:1',
      token: '',
      fetch: (async () => new Response('oops', { status: 200 })) as unknown as typeof fetch,
      subscribe: false,
    });
    await expect(nonJson.request('x')).rejects.toMatchObject({ code: 'internal' });

    expect(() => createHttpRpcClient({ baseUrl: 'http://example.com:8642', token: 't' })).toThrow(
      RpcClientError,
    );
  });

  it('WS 只处理事件帧，close 关闭连接', async () => {
    class FakeSocket {
      readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
      closed = false;

      constructor(readonly url: string) {}

      addEventListener(type: string, listener: (event?: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }

      close(): void {
        this.closed = true;
      }

      emitMessage(data: unknown): void {
        for (const listener of this.listeners.get('message') ?? []) listener({ data });
      }
    }

    const sockets: FakeSocket[] = [];
    const client = createHttpRpcClient({
      baseUrl: 'https://127.0.0.1:8642',
      token: 'tok',
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
      webSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
    });

    const received: RpcEventNotification[] = [];
    const unsubscribe = client.subscribe((notification) => received.push(notification));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toContain('wss://127.0.0.1:8642/ws');
    expect(sockets[0]?.url).toContain('token=tok');

    sockets[0]?.emitMessage(JSON.stringify({ type: 'run.started', run_id: 'r1', data: {}, ts: 1 }));
    sockets[0]?.emitMessage(
      JSON.stringify({ method: 'events.event', params: { type: 'run.completed' } }),
    );
    sockets[0]?.emitMessage(JSON.stringify({ type: 'pong' }));
    sockets[0]?.emitMessage('not-json');

    expect(received).toHaveLength(2);
    expect(received[0]?.params).toMatchObject({ type: 'run.started', run_id: 'r1' });
    expect(received[1]?.params).toEqual({ type: 'run.completed' });

    unsubscribe();
    await client.close();
    expect(sockets[0]?.closed).toBe(true);
  });
});

describe('serve-auth (0.5)', () => {
  it('legacy serve.token → default/admin；无 token → 401 语义', () => {
    const result = resolveGatewayAuth(
      { serve: { token: 'legacy' } },
      { hostname: '127.0.0.1', allowRemote: false, env: {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.auth.configured).toBe(true);
    expect(result.auth.legacyToken).toBe('legacy');
    expect(result.auth.authenticate('legacy')).toEqual({
      tenant_id: 'default',
      role: 'admin',
    });
    expect(result.auth.authenticate('wrong')).toBeNull();
    expect(result.auth.authenticate(null)).toBeNull();
    expect(result.auth.anonymous).toBeUndefined();
  });

  it('serve.tokens map 与 admin token', () => {
    const result = resolveGatewayAuth(
      {
        serve: {
          tokens: {
            'tok-read': { tenantId: 'acme', role: 'read' },
            'tok-default': {},
          },
          adminToken: 'admin-tok',
        },
      },
      { hostname: '127.0.0.1', allowRemote: false, env: {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.auth.authenticate('tok-read')).toEqual({ tenant_id: 'acme', role: 'read' });
    expect(result.auth.authenticate('tok-default')).toEqual({ tenant_id: 'default', role: 'read' });
    expect(result.auth.authenticate('admin-tok')).toEqual({ tenant_id: '*', role: 'admin' });
  });

  it('tokenEnv / adminTokenEnv / VESSEL_GATEWAY_TOKEN 回退', () => {
    const env = {
      REMOTE_TOKEN: 'env-token',
      ADMIN_ENV: 'env-admin',
      VESSEL_GATEWAY_TOKEN: 'vessel-token',
    };

    const fromServe = resolveGatewayAuth(
      { serve: { tokenEnv: 'REMOTE_TOKEN', adminTokenEnv: 'ADMIN_ENV' } },
      { hostname: '127.0.0.1', allowRemote: false, env },
    );
    expect(fromServe.ok).toBe(true);
    if (fromServe.ok) {
      expect(fromServe.auth.authenticate('env-token')?.role).toBe('admin');
      expect(fromServe.auth.authenticate('env-admin')?.tenant_id).toBe('*');
    }

    const fromVessel = resolveGatewayAuth(
      {},
      {
        hostname: '127.0.0.1',
        allowRemote: false,
        env,
      },
    );
    expect(fromVessel.ok).toBe(true);
    if (fromVessel.ok) {
      expect(fromVessel.auth.authenticate('vessel-token')).toEqual({
        tenant_id: 'default',
        role: 'admin',
      });
    }
  });

  it('回环 + 无 token → anonymous default/admin', () => {
    const result = resolveGatewayAuth(
      {},
      {
        hostname: 'localhost',
        allowRemote: false,
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.auth.configured).toBe(false);
    expect(result.auth.anonymous).toEqual({ tenant_id: 'default', role: 'admin' });
    expect(result.auth.authenticate(null)).toEqual({ tenant_id: 'default', role: 'admin' });
    expect(result.auth.authenticate('')).toEqual({ tenant_id: 'default', role: 'admin' });
  });

  it('非回环 + 无 token → 拒绝启动；错误不含 token', () => {
    const result = resolveGatewayAuth(
      {},
      {
        hostname: '0.0.0.0',
        allowRemote: true,
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('gateway_requires_token');
      expect(result.error).not.toContain('gateway-token-value');
    }
  });

  it('safeTokenEqual 正确且长度无关', () => {
    expect(safeTokenEqual('abc', 'abc')).toBe(true);
    expect(safeTokenEqual('abc', 'abd')).toBe(false);
    expect(safeTokenEqual('a', 'longer-token')).toBe(false);
  });
});
