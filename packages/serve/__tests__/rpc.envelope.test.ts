import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(
  entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }>,
  legacyToken?: string,
): GatewayAuthLike {
  return {
    configured: true,
    ...(legacyToken !== undefined ? { legacyToken } : {}),
    authenticate(token: string | null) {
      if (token === null) return null;
      return entries[token] ?? null;
    },
  };
}

async function rpc(
  gateway: Gateway,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function envelope(id: string, method: string, params?: unknown): Record<string, unknown> {
  return { v: 1, id, method, ...(params !== undefined ? { params } : {}) };
}

describe('rpc envelope', () => {
  it('serves health.get with a valid envelope', async () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 't' });
    gateways.push(gateway);
    const { status, body } = await rpc(gateway, envelope('1', 'health.get'), 't');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const result = body.result as { status: string; latest_seq: number; tenant_id: string };
    expect(result.status).toBe('ok');
    expect(result.latest_seq).toBe(0);
    expect(result.tenant_id).toBe('default');
  });

  it('returns not_found with details.method for unknown methods', async () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 't' });
    gateways.push(gateway);
    const { status, body } = await rpc(gateway, envelope('2', 'nope.nope'), 't');
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    const error = body.error as { code: string; details: { method: string } };
    expect(error.code).toBe('not_found');
    expect(error.details.method).toBe('nope.nope');
  });

  it('rejects malformed envelopes with HTTP 400 invalid_params', async () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 't' });
    gateways.push(gateway);
    const badJson = await fetch(`${gateway.url}/v1/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_params',
    );

    const missingId = await rpc(gateway, { v: 1, method: 'health.get' }, 't');
    expect(missingId.status).toBe(400);
    expect((missingId.body.error as { code: string }).code).toBe('invalid_params');

    const wrongVersion = await rpc(gateway, { v: 2, id: 'x', method: 'health.get' }, 't');
    expect(wrongVersion.status).toBe(400);
  });

  it('requires a token and keeps method errors at HTTP 200', async () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 't' });
    gateways.push(gateway);
    const unauthenticated = await rpc(gateway, envelope('1', 'health.get'));
    expect(unauthenticated.status).toBe(401);

    const methodError = await rpc(gateway, envelope('1', 'sessions.get', { session_id: 'x' }), 't');
    expect(methodError.status).toBe(200);
    expect(methodError.body.ok).toBe(false);
    expect((methodError.body.error as { code: string }).code).toBe('not_found');
  });

  it('enforces permission levels from the manifest', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor({ r: { tenant_id: 'default', role: 'read' } }),
    });
    gateways.push(gateway);
    const denied = await rpc(gateway, envelope('1', 'runs.start', { input: 'hi' }), 'r');
    expect(denied.status).toBe(200);
    expect(denied.body.ok).toBe(false);
    const error = denied.body.error as {
      code: string;
      details?: { method?: string; required?: string };
    };
    expect(error.code).toBe('forbidden');
    expect(error.details).toMatchObject({ method: 'runs.start', required: 'write' });
  });
});

describe('capabilities manifest', () => {
  it('is generated from the method table and advertises v1.1 methods', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 't',
      version: '9.9.9',
      plugins: () => [{ name: 'demo', enabled: true }],
    });
    gateways.push(gateway);
    const { body } = await rpc(gateway, envelope('1', 'capabilities.list'), 't');
    expect(body.ok).toBe(true);
    const manifest = body.result as {
      version: string;
      config_schema_version: number;
      methods: Array<{ name: string; permission: string }>;
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    expect(manifest.version).toBe('9.9.9');
    expect(manifest.config_schema_version).toBe(1);
    const names = manifest.methods.map((method) => method.name);
    for (const name of [
      'health.get',
      'capabilities.list',
      'config.get',
      'config.sources',
      'sessions.list',
      'sessions.delete',
      'runs.start',
      'runs.resume',
      'events.list',
      'events.subscribe',
      'metrics.get',
      'mcp.list',
      'mcp.reconnect',
      'trace.prune',
      'tenants.list',
      'workflow.get',
      'evals.latest',
      'permission.respond',
      'ask.respond',
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('team.dispatch');
    expect(names).not.toContain('run.submit');
    expect(manifest.methods.find((method) => method.name === 'trace.prune')?.permission).toBe(
      'admin',
    );
    expect(manifest.plugins).toEqual([{ name: 'demo', enabled: true }]);
  });

  it('exposes the same manifest via Gateway.manifest()', () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 't' });
    gateways.push(gateway);
    expect(gateway.manifest().methods.map((method) => method.name)).toContain('health.get');
  });
});

describe('canonical methods', () => {
  it('serves config.get / config.sources from the injected snapshot', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 't',
      config: {
        snapshot: (tenantId) => ({
          schema_version: 1,
          config: { provider: { apiKey: '***' } },
          sources: { 'provider.apiKey': 'env' },
          paths: { user: '/u', project: '/p' },
          tenant_id: tenantId,
          tenant_overlay_keys: ['provider.model'],
        }),
      },
    });
    gateways.push(gateway);
    const getResult = await rpc(gateway, envelope('1', 'config.get'), 't');
    expect(getResult.body.ok).toBe(true);
    expect((getResult.body.result as { config: unknown }).config).toEqual({
      provider: { apiKey: '***' },
    });
    const sourcesResult = await rpc(gateway, envelope('2', 'config.sources'), 't');
    expect((sourcesResult.body.result as { sources: unknown }).sources).toEqual({
      'provider.apiKey': 'env',
    });
    expect(
      (sourcesResult.body.result as { tenant_overlay_keys: string[] }).tenant_overlay_keys,
    ).toEqual(['provider.model']);
  });

  it('serves sessions.get / rename / delete through injected backends', async () => {
    const saved: Array<{ title?: string }> = [];
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 't',
      session: {
        async load(id) {
          if (id !== 's1') return null;
          return {
            run_id: 'r1',
            session_id: 's1',
            messages: [],
            started_at: 1,
            status: 'completed',
            title: 'old',
          };
        },
        async save(state) {
          saved.push({ title: state.title });
        },
        async delete() {},
        async list() {
          return ['s1'];
        },
        async listRich() {
          return [
            {
              session_id: 's1',
              title: 'old',
              preview: '',
              status: 'completed',
              started_at: 1,
              updated_at: 1,
              message_count: 0,
            },
          ];
        },
      },
      sessionData: {
        async deleteSessionData(sessionId) {
          return {
            sessions_deleted: sessionId === 's1' ? 1 : 0,
            runs_deleted: 2,
            events_deleted: 3,
          };
        },
      },
    });
    gateways.push(gateway);

    const detail = await rpc(gateway, envelope('1', 'sessions.get', { session_id: 's1' }), 't');
    expect((detail.body.result as { session: { title: string } }).session.title).toBe('old');

    const renamed = await rpc(
      gateway,
      envelope('2', 'sessions.rename', { session_id: 's1', title: 'new' }),
      't',
    );
    expect(renamed.body.ok).toBe(true);
    expect(saved).toEqual([{ title: 'new' }]);

    const deleted = await rpc(gateway, envelope('3', 'sessions.delete', { session_id: 's1' }), 't');
    expect(deleted.body.result).toEqual({
      sessions_deleted: 1,
      runs_deleted: 2,
      events_deleted: 3,
    });
  });

  it('serves metrics live/trace, reset, mcp and trace.prune', async () => {
    const snapshot = {
      runs: { started: 1, completed: 1, failed: 0, cancelled: 0 },
      tool_calls: { total: 1, failed: 0 },
      llm: { requests: 1, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      duration_ms: { total: 10, max: 10, avg: 10 },
      updated_at: 5,
    };
    let reset = 0;
    let pruned: Record<string, unknown> | undefined;
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 't',
      metrics: () => snapshot,
      metricsControl: {
        reset: () => {
          reset += 1;
        },
        rebuild: async (tenantId) => ({ ...snapshot, updated_at: tenantId === 'default' ? 7 : 0 }),
      },
      mcp: {
        listServers: () => [{ name: 'demo', status: 'connected', tools: ['t'] }],
        reconnect: async () => {},
      },
      trace: {
        prune: async (options) => {
          pruned = options;
          return { deleted_runs: 1, kept_runs: 0, deleted_bytes: 10 };
        },
      },
    });
    gateways.push(gateway);

    const live = await rpc(gateway, envelope('1', 'metrics.get'), 't');
    expect((live.body.result as { source: string }).source).toBe('live');
    const trace = await rpc(gateway, envelope('2', 'metrics.get', { source: 'trace' }), 't');
    expect((trace.body.result as { metrics: { updated_at: number } }).metrics.updated_at).toBe(7);
    expect((await rpc(gateway, envelope('3', 'metrics.reset'), 't')).body.ok).toBe(true);
    expect(reset).toBe(1);

    const mcp = await rpc(gateway, envelope('4', 'mcp.list'), 't');
    expect((mcp.body.result as { servers: unknown[] }).servers).toHaveLength(1);
    expect(
      (await rpc(gateway, envelope('5', 'mcp.reconnect', { name: 'demo' }), 't')).body.ok,
    ).toBe(true);

    const prune = await rpc(gateway, envelope('6', 'trace.prune', { max_runs: 1 }), 't');
    expect(prune.body.ok).toBe(true);
    expect(pruned?.tenant_id).toBe('default');
  });
});
