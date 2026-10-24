import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildFederationMessage,
  FederationClientError,
  type FederationPostResult,
  postFederation,
} from '../federation-client';
import type { FederationRuntimeOptions, FederationRuntimePeer } from '../federation-config';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

interface Captured {
  headers: Headers;
  body: Record<string, unknown>;
}

/** 起一个本地 mock；handler 决定响应，测试读 captured。 */
function startServer(handler: (captured: Captured) => Response | Promise<Response>): {
  url: string;
  captured: () => Captured | undefined;
} {
  let captured: Captured | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      const entry = { headers: request.headers, body };
      captured = entry;
      return handler(entry);
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    captured: () => captured,
  };
}

function peer(overrides: Partial<FederationRuntimePeer> = {}): FederationRuntimePeer {
  return {
    nodeId: 'node-b',
    teamId: 'beta',
    direction: 'out',
    tokenEnv: 'PEER_TOKEN',
    token: 'secret-token-value',
    allowDirectory: false,
    ...overrides,
  };
}

function options(overrides: Partial<FederationRuntimeOptions> = {}): FederationRuntimeOptions {
  return {
    enabled: true,
    nodeId: 'node-a',
    maxHops: 4,
    rateLimitPerMinute: 60,
    peers: [peer()],
    ...overrides,
  };
}

const input = {
  from: { principal: 'alice', node_id: 'node-a', team_id: 'alpha' },
  to: { principal: 'eggrolls', node_id: 'node-b', team_id: 'beta' },
  content: 'hello from alpha',
};

function success(extra: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      protocol: 'vessel.federation/1',
      ok: true,
      message_id: 'remote-1',
      cursor: 'cursor-1',
      ...extra,
    },
    { status: 202 },
  );
}

describe('postFederation', () => {
  it('returns federation_disabled without a request when disabled', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests++;
        return success();
      },
    });
    servers.push(server);
    const result = await postFederation(
      options({
        enabled: false,
        peers: [peer({ url: `http://127.0.0.1:${server.port}` })],
      }),
      input,
    );
    expect(result).toEqual({
      status: 'rejected',
      code: 'federation_disabled',
      reason: expect.any(String),
    });
    expect(requests).toBe(0);
  });

  it('returns federation_not_allowed without a request for an unknown target', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests++;
        return success();
      },
    });
    servers.push(server);
    const result = await postFederation(
      options({
        peers: [peer({ url: `http://127.0.0.1:${server.port}` })],
      }),
      { ...input, to: { ...input.to, node_id: 'node-x' } },
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.code).toBe('federation_not_allowed');
    expect(requests).toBe(0);
  });

  it('returns federation_not_allowed when the peer direction excludes out', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests++;
        return success();
      },
    });
    servers.push(server);
    const result = await postFederation(
      options({
        peers: [peer({ direction: 'in', url: `http://127.0.0.1:${server.port}` })],
      }),
      input,
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.code).toBe('federation_not_allowed');
    expect(requests).toBe(0);
  });

  it('sends the frozen envelope and reports delivered on 202', async () => {
    const mock = startServer(() => success());
    const result = await postFederation(options({ peers: [peer({ url: mock.url })] }), input, {
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({
      status: 'delivered',
      message_id: 'remote-1',
      hop: 1,
      cursor: 'cursor-1',
    });

    const captured = mock.captured();
    expect(captured).toBeDefined();
    if (captured === undefined) return;
    expect(captured.headers.get('authorization')).toBe('Bearer secret-token-value');
    expect(captured.headers.get('content-type')).toContain('application/json');
    expect(captured.body).toEqual({
      protocol: 'vessel.federation/1',
      message_id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      conversation_id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      from: { principal: 'alice', node_id: 'node-a', team_id: 'alpha' },
      to: { principal: 'eggrolls', node_id: 'node-b', team_id: 'beta' },
      content: 'hello from alpha',
      ts: 1_700_000_000_000,
      hop: 1,
    });
  });

  it('reports deduplicated when the peer says so', async () => {
    const mock = startServer(() => success({ deduplicated: true }));
    const result = await postFederation(options({ peers: [peer({ url: mock.url })] }), input);
    expect(result).toEqual({
      status: 'deduplicated',
      message_id: 'remote-1',
      hop: 1,
      cursor: 'cursor-1',
    });
  });

  it('maps non-2xx to federation_peer_error with remote_code', async () => {
    const mock = startServer(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'federation_not_allowed', message: 'denied' } }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = await postFederation(options({ peers: [peer({ url: mock.url })] }), input);
    expect(result).toEqual({
      status: 'rejected',
      code: 'federation_peer_error',
      reason: 'denied',
      remote_code: 'federation_not_allowed',
    });
  });

  it('maps connection failures to federation_peer_unreachable without the token', async () => {
    const result = await postFederation(
      options({ peers: [peer({ url: 'http://127.0.0.1:1' })] }),
      input,
      { timeoutMs: 500 },
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.code).toBe('federation_peer_unreachable');
    expect(result.reason).not.toContain('secret-token-value');
  });

  it('maps timeouts to federation_peer_unreachable', async () => {
    const mock = startServer(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const result = await postFederation(options({ peers: [peer({ url: mock.url })] }), input, {
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.code).toBe('federation_peer_unreachable');
  });

  it('rejects a peer without url as a configuration error', async () => {
    await expect(postFederation(options(), input)).rejects.toMatchObject({
      name: 'FederationClientError',
      code: 'federation_invalid_config',
    });
  });

  it('rejects a non-http(s) peer url as a configuration error', async () => {
    await expect(
      postFederation(options({ peers: [peer({ url: 'ftp://example.test' })] }), input),
    ).rejects.toMatchObject({ code: 'federation_invalid_config' });
  });

  it('rejects invalid content / ids before sending', async () => {
    const tooLong = 'a'.repeat(65_537);
    await expect(postFederation(options(), { ...input, content: tooLong })).rejects.toMatchObject({
      code: 'federation_invalid',
    });
    await expect(postFederation(options(), { ...input, content: '' })).rejects.toBeInstanceOf(
      FederationClientError,
    );
    await expect(
      postFederation(options(), { ...input, conversation_id: 'bad id with spaces' }),
    ).rejects.toMatchObject({ code: 'federation_invalid' });
  });

  it('rejects a from node that is not this node without calling fetch', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return success();
    }) as unknown as typeof fetch;
    await expect(
      postFederation(
        options({ peers: [peer({ url: 'http://127.0.0.1:1' })] }),
        { ...input, from: { ...input.from, node_id: 'node-x' } },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'federation_invalid' });
    expect(calls).toBe(0);
  });

  it('rejects an invalid address segment without calling fetch', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return success();
    }) as unknown as typeof fetch;
    await expect(
      postFederation(
        options({ peers: [peer({ url: 'http://127.0.0.1:1' })] }),
        { ...input, to: { ...input.to, principal: 'bad.principal' } },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'federation_invalid' });
    expect(calls).toBe(0);
  });

  it('builds hop=1 and generates ids in the frozen pattern', () => {
    const message = buildFederationMessage(options(), input);
    expect(message.hop).toBe(1);
    expect(message.message_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(message.conversation_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });

  it('does not leak the token into serialized results', async () => {
    const mock = startServer(() => success());
    const result: FederationPostResult = await postFederation(
      options({ peers: [peer({ url: mock.url })] }),
      input,
    );
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });
});
