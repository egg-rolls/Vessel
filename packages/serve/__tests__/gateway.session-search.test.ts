import { afterEach, describe, expect, it } from 'bun:test';
import type { RunState } from '@vessel-agent/core';
import { MemoryEventStream, MemorySessionBackend } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import {
  DEFAULT_SESSION_SEARCH_LIMIT,
  findSessionSnippet,
  makeSnippet,
  normalizeSearchQuery,
  parseSearchLimit,
} from '../src/session-search';
import type { GatewayAuthLike } from '../src/tenant';
import { startTestGateway as startGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function state(
  sessionId: string,
  messages: RunState['messages'],
  overrides: Partial<RunState> = {},
): RunState {
  return {
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    messages,
    started_at: 1000,
    updated_at: 2000,
    status: 'completed',
    ...overrides,
  };
}

function auth(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    reader: { tenant_id: 'default', role: 'read' },
    writer: { tenant_id: 'default', role: 'write' },
    'b-reader': { tenant_id: 'b', role: 'read' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

async function rpc(
  gateway: Gateway,
  token: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

function hits(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.result as { sessions?: Array<Record<string, unknown>> } | undefined)?.sessions ?? [];
}

describe('session search helpers', () => {
  it('normalizes queries and limits', () => {
    expect(normalizeSearchQuery('  needle  ')).toBe('needle');
    expect(normalizeSearchQuery('   ')).toBeNull();
    expect(normalizeSearchQuery('x'.repeat(257))).toBeNull();
    expect(normalizeSearchQuery(42)).toBeNull();
    expect(parseSearchLimit(undefined)).toBe(DEFAULT_SESSION_SEARCH_LIMIT);
    expect(parseSearchLimit(1)).toBe(1);
    expect(parseSearchLimit(100)).toBe(100);
    for (const invalid of [0, 101, 1.5, '10', null]) {
      expect(parseSearchLimit(invalid)).toBeNull();
    }
  });

  it('builds a windowed snippet and matches messages before falling back', () => {
    const content = `${'x'.repeat(100)} needle ${'y'.repeat(100)}`;
    const snippet = makeSnippet(content, 'needle');
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);

    const info = { session_id: 's1', title: 'Alpha', preview: 'first preview' };
    expect(findSessionSnippet(info, [{ role: 'user', content: 'no hit' }], 'alpha')).toBe(
      'first preview',
    );
    expect(
      findSessionSnippet(info, [{ role: 'assistant', content: 'deep needle here' }], 'needle'),
    ).toBe('deep needle here');
    expect(findSessionSnippet(info, [{ role: 'user', content: 'nope' }], 'missing')).toBeNull();
  });
});

describe('sessions.search RPC', () => {
  async function makeGateway(tokens = auth()) {
    const backend = new MemorySessionBackend();
    await backend.save(
      state('s1', [
        { role: 'user', content: 'Hello World' },
        { role: 'assistant', content: 'The hidden needle is in this answer' },
      ]),
    );
    await backend.save(
      state(
        's2',
        [
          { role: 'user', content: 'Unrelated conversation' },
          { role: 'assistant', content: 'nothing to find' },
        ],
        { updated_at: 1000 },
      ),
    );
    const backendB = new MemorySessionBackend();
    await backendB.save(state('b1', [{ role: 'user', content: 'shared tenant needle b only' }]));

    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: tokens,
      session: backend,
      sessionFor: (tenantId) => (tenantId === 'b' ? backendB : undefined),
    });
    gateways.push(gateway);
    return gateway;
  }

  it('searches message content and returns the frozen hit shape', async () => {
    const gateway = await makeGateway();
    const body = await rpc(gateway, 'reader', 'sessions.search', { query: 'NEEDLE' });
    expect(body.ok).toBe(true);
    const results = hits(body);
    expect(results).toHaveLength(1);
    expect(results[0]?.session_id).toBe('s1');
    expect(results[0]?.title).toBe('Hello World');
    expect(results[0]?.preview).toBe('Hello World');
    expect(results[0]?.snippet).toContain('needle');
    expect(results[0]?.updated_at).toBe(2000);
    expect(results[0]?.message_count).toBe(2);
  });

  it('matches title/id and supports limit', async () => {
    const gateway = await makeGateway();
    const title = await rpc(gateway, 'reader', 'sessions.search', { query: 'unrelated' });
    expect(hits(title).map((hit) => hit.session_id)).toEqual(['s2']);

    const limited = await rpc(gateway, 'reader', 'sessions.search', {
      query: 'e',
      limit: 1,
    });
    expect(hits(limited)).toHaveLength(1);
  });

  it('rejects empty/oversized queries and invalid limits', async () => {
    const gateway = await makeGateway();
    for (const params of [
      { query: '   ' },
      { query: 'x'.repeat(257) },
      { query: 'needle', limit: 0 },
      { query: 'needle', limit: 101 },
    ]) {
      const body = await rpc(gateway, 'reader', 'sessions.search', params);
      expect(body.ok).toBe(false);
      expect((body.error as { code: string }).code).toBe('invalid_params');
    }
  });

  it('scopes results by the token tenant', async () => {
    const gateway = await makeGateway();
    const local = await rpc(gateway, 'writer', 'sessions.search', { query: 'needle' });
    expect(hits(local).map((hit) => hit.session_id)).toEqual(['s1']);

    const other = await rpc(gateway, 'b-reader', 'sessions.search', { query: 'needle' });
    expect(hits(other).map((hit) => hit.session_id)).toEqual(['b1']);
  });

  it('returns forbidden for non-default tenants without a backend', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      session: new MemorySessionBackend(),
    });
    gateways.push(gateway);

    const body = await rpc(gateway, 'b-reader', 'sessions.search', { query: 'needle' });
    expect(body.ok).toBe(false);
    expect((body.error as { code: string }).code).toBe('forbidden');
  });
});
