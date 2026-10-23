import { describe, expect, it } from 'bun:test';
import { createHubTokenBroker, HubTokenBrokerError } from '../hub/token-broker';
import { pairingSecretKey, type SecretStore } from '../hub/types';

interface StoreHarness {
  store: SecretStore;
  gets: string[];
  sets: string[];
}

interface FetchCall {
  url: string;
  init: RequestInit & { tls?: { ca: string } };
}

interface FetchHarness {
  fetch: typeof fetch;
  calls: FetchCall[];
}

function makeStore(entries: Record<string, string> = {}): StoreHarness {
  const values = new Map(Object.entries(entries));
  const gets: string[] = [];
  const sets: string[] = [];
  return {
    gets,
    sets,
    store: {
      async get(key) {
        gets.push(key);
        return values.get(key);
      },
      async set(key, value) {
        sets.push(key);
        values.set(key, value);
      },
      async delete(key) {
        values.delete(key);
      },
    },
  };
}

function makeFetch(result: { status?: number; body?: unknown } | Error): FetchHarness {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: (init ?? {}) as FetchCall['init'] });
    if (result instanceof Error) throw result;
    const body = result.body === undefined ? '' : JSON.stringify(result.body);
    return new Response(body, {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function exchangeResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    id: 'req-1',
    ok: true,
    result: {
      token: 'control-token-plaintext',
      token_id: 'tok-control-1',
      scope: 'control',
      tenant_id: 'tenant-a',
      node_id: 'node-1',
      team_id: 'team-1',
      expires_at: 1_800_000_000_000,
      ...overrides,
    },
  };
}

async function expectBrokerCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HubTokenBrokerError);
    expect((error as HubTokenBrokerError).code).toBe(code);
    return;
  }
  throw new Error(`expected HubTokenBrokerError(${code})`);
}

const pairingId = 'node-1:tenant-a';
const exchangeKey = pairingSecretKey(pairingId, 'exchange');

const input = {
  pairing_id: pairingId,
  node_id: 'node-1',
  url: 'http://127.0.0.1:8642',
  team_id: 'team-1',
  ttl_s: 600,
};

describe('createHubTokenBroker.exchangeForTeam', () => {
  it('exchanges the pairing token for a control token', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
    const fakeFetch = makeFetch({ body: exchangeResult() });
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    const token = await broker.exchangeForTeam(input);

    expect(token).toEqual({
      node_id: 'node-1',
      pairing_id: pairingId,
      team_id: 'team-1',
      url: 'http://127.0.0.1:8642',
      token: 'control-token-plaintext',
      token_id: 'tok-control-1',
      expires_at: 1_800_000_000_000,
      scope: 'control',
    });

    expect(store.gets).toEqual([exchangeKey]);
    expect(fakeFetch.calls).toHaveLength(1);
    const call = fakeFetch.calls[0];
    if (!call) throw new Error('missing fetch call');
    expect(call.url).toBe('http://127.0.0.1:8642/v1/rpc');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer exchange-token-plaintext');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(call.init.body)) as {
      v: number;
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.v).toBe(1);
    expect(typeof body.id).toBe('string');
    expect(body.method).toBe('auth.exchange');
    expect(body.params).toEqual({ team_id: 'team-1', ttl_s: 600 });

    // 不持久化：只读 exchange secret，绝不写回。
    expect(store.sets).toEqual([]);
  });

  it('omits ttl_s when the caller does not set it', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
    const fakeFetch = makeFetch({ body: exchangeResult() });
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    await broker.exchangeForTeam({
      pairing_id: pairingId,
      node_id: 'node-1',
      url: 'http://127.0.0.1:8642',
      team_id: 'team-1',
    });

    const body = JSON.parse(String(fakeFetch.calls[0]?.init.body)) as { params: unknown };
    expect(body.params).toEqual({ team_id: 'team-1' });
  });

  it('fails with not_paired when the exchange secret is missing', async () => {
    const store = makeStore();
    const fakeFetch = makeFetch({ body: exchangeResult() });
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    await expectBrokerCode(broker.exchangeForTeam(input), 'not_paired');
    expect(store.gets).toEqual([exchangeKey]);
    expect(fakeFetch.calls).toHaveLength(0);
  });

  it('maps HTTP 401 and 403 to unauthorized', async () => {
    for (const status of [401, 403]) {
      const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
      const fakeFetch = makeFetch({ status, body: { message: 'nope' } });
      const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

      await expectBrokerCode(broker.exchangeForTeam(input), 'unauthorized');
    }
  });

  it('propagates RPC error codes from the node', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
    const fakeFetch = makeFetch({
      body: {
        v: 1,
        id: 'req-1',
        ok: false,
        error: { code: 'forbidden', message: 'exchange token revoked' },
      },
    });
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    await expectBrokerCode(broker.exchangeForTeam(input), 'forbidden');
  });

  it('maps network failures to node_unreachable', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
    const fakeFetch = makeFetch(new Error('connect ECONNREFUSED'));
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    await expectBrokerCode(broker.exchangeForTeam(input), 'node_unreachable');
  });

  it('rejects non-loopback plaintext urls without reading the secret', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });
    const fakeFetch = makeFetch({ body: exchangeResult() });
    const broker = createHubTokenBroker({ secretStore: store.store, fetch: fakeFetch.fetch });

    await expectBrokerCode(
      broker.exchangeForTeam({ ...input, url: 'http://node.example.com' }),
      'invalid_params',
    );
    expect(store.gets).toEqual([]);
    expect(fakeFetch.calls).toHaveLength(0);
  });

  it('rejects malformed envelopes and non-control tokens', async () => {
    const store = makeStore({ [exchangeKey]: 'exchange-token-plaintext' });

    const malformed = createHubTokenBroker({
      secretStore: store.store,
      fetch: makeFetch({ body: {} }).fetch,
    });
    await expectBrokerCode(malformed.exchangeForTeam(input), 'internal');

    const wrongScope = createHubTokenBroker({
      secretStore: store.store,
      fetch: makeFetch({ body: exchangeResult({ scope: 'admin' }) }).fetch,
    });
    await expectBrokerCode(wrongScope.exchangeForTeam(input), 'internal');
  });
});
