import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentStatus, InboxPage } from '@vessel/core';
import { MemoryEventStream } from '@vessel/core';
import type { DurableCheckpointLike, DurableStoreLike } from '../src/durable';
import { type Gateway, startGateway } from '../src/gateway';
import type { TeamHostLike, TeamSpawnRequest } from '../src/team';
import type { GatewayAuthLike } from '../src/tenant';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function auth(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    reader: { tenant_id: 'default', role: 'read' },
    writer: { tenant_id: 'default', role: 'write' },
    'b-reader': { tenant_id: 'b', role: 'read' },
    'b-writer': { tenant_id: 'b', role: 'write' },
    admin: { tenant_id: '*', role: 'admin' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function checkpoint(runId: string, overrides: Partial<DurableCheckpointLike> = {}) {
  return {
    run_id: runId,
    session_id: 's1',
    status: 'interrupted' as const,
    updated_at: 1000,
    messages: [{ role: 'user', content: `input-${runId}` }],
    ...overrides,
  };
}

function storeOf(checkpoints: DurableCheckpointLike[]): DurableStoreLike {
  const map = new Map(checkpoints.map((item) => [item.run_id, item]));
  return {
    async load(runId) {
      return map.get(runId) ?? null;
    },
    async list(opts) {
      return [...map.values()].filter(
        (item) =>
          (opts?.status === undefined || item.status === opts.status) &&
          (opts?.session_id === undefined || item.session_id === opts.session_id),
      );
    },
  };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

async function durableFetch(
  gateway: Gateway,
  token: string,
  path: string,
  method = 'GET',
): Promise<Response> {
  return fetch(`${gateway.url}${path}`, { method, headers: authHeader(token) });
}

describe('durable endpoint tenant and role enforcement', () => {
  it('forbids non-default tenants without a per-tenant store', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      durable: { store: storeOf([checkpoint('run-a')]), resume: () => {} },
    });
    gateways.push(gateway);

    const list = await durableFetch(gateway, 'b-writer', '/v1/durable/runs');
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe('forbidden');

    const resume = await durableFetch(gateway, 'b-writer', '/v1/durable/runs/run-a/resume', 'POST');
    expect(resume.status).toBe(403);
  });

  it('lets default read tokens list but not resume', async () => {
    let resumed = 0;
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      durable: {
        store: storeOf([checkpoint('run-a')]),
        resume: () => {
          resumed += 1;
        },
      },
    });
    gateways.push(gateway);

    const list = await durableFetch(gateway, 'reader', '/v1/durable/runs');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { runs: unknown[] }).runs).toHaveLength(1);

    const resume = await durableFetch(gateway, 'reader', '/v1/durable/runs/run-a/resume', 'POST');
    expect(resume.status).toBe(403);
    expect(((await resume.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect(resumed).toBe(0);

    const allowed = await durableFetch(gateway, 'writer', '/v1/durable/runs/run-a/resume', 'POST');
    expect(allowed.status).toBe(202);
    expect(resumed).toBe(1);
  });

  it('filters tagged checkpoints from a shared default store', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      durable: {
        store: storeOf([
          checkpoint('run-default'),
          checkpoint('run-b', { tenant_id: 'b' }),
          checkpoint('run-untagged'),
        ]),
        resume: () => {},
      },
    });
    gateways.push(gateway);

    const list = await durableFetch(gateway, 'reader', '/v1/durable/runs');
    const body = (await list.json()) as { runs: Array<{ run_id: string }> };
    expect(body.runs.map((run) => run.run_id).sort()).toEqual(['run-default', 'run-untagged']);

    const crossTenant = await durableFetch(
      gateway,
      'writer',
      '/v1/durable/runs/run-b/resume',
      'POST',
    );
    expect(crossTenant.status).toBe(403);
  });

  it('uses an injected per-tenant store for non-default tenants', async () => {
    const resumed: string[] = [];
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      durable: { store: storeOf([]), resume: () => {} },
      durableFor: (tenantId) =>
        tenantId === 'b'
          ? {
              store: storeOf([checkpoint('run-b')]),
              resume: (runId) => {
                resumed.push(runId);
              },
            }
          : undefined,
    });
    gateways.push(gateway);

    const list = await durableFetch(gateway, 'b-reader', '/v1/durable/runs');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { runs: Array<{ run_id: string }> }).runs[0]?.run_id).toBe(
      'run-b',
    );

    const readResume = await durableFetch(
      gateway,
      'b-reader',
      '/v1/durable/runs/run-b/resume',
      'POST',
    );
    expect(readResume.status).toBe(403);

    const writeResume = await durableFetch(
      gateway,
      'b-writer',
      '/v1/durable/runs/run-b/resume',
      'POST',
    );
    expect(writeResume.status).toBe(202);
    expect(resumed).toEqual(['run-b']);
  });

  it('applies the same tenant scope to canonical runs.get/runs.resume', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      durable: { store: storeOf([checkpoint('run-a')]), resume: () => {} },
    });
    gateways.push(gateway);

    const rpc = async (token: string, method: string, params: unknown) => {
      const response = await fetch(`${gateway.url}/v1/rpc`, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, params }),
      });
      return (await response.json()) as Record<string, unknown>;
    };

    const getB = await rpc('b-writer', 'runs.get', { run_id: 'run-a' });
    expect(getB.ok).toBe(false);
    expect((getB.error as { code: string }).code).toBe('forbidden');

    const resumeRead = await rpc('reader', 'runs.resume', { run_id: 'run-a' });
    expect(resumeRead.ok).toBe(false);
    expect((resumeRead.error as { code: string }).code).toBe('forbidden');

    const resumeWrite = await rpc('writer', 'runs.resume', { run_id: 'run-a' });
    expect(resumeWrite.ok).toBe(true);
  });
});

function makeTeamHost() {
  const statuses = new Map<string, AgentStatus>();
  const host: TeamHostLike = {
    list: () => [...statuses.values()],
    get: (id) => {
      const status = statuses.get(id);
      if (!status) return undefined;
      return {
        status: () => status,
        close: async () => {
          statuses.delete(id);
        },
      };
    },
    inbox: async (): Promise<InboxPage> => ({ messages: [], cursor: '0' }),
    cancel: (id) => {
      const status = statuses.get(id);
      if (status) statuses.set(id, { ...status, state: 'cancelled' });
    },
  };
  const spawn = async (request: TeamSpawnRequest): Promise<AgentStatus> => {
    const status: AgentStatus = {
      id: 'worker',
      ...(request.name !== undefined ? { name: request.name } : {}),
      state: 'idle',
      toolNames: ['read'],
    };
    statuses.set('worker', status);
    return status;
  };
  return { host, spawn };
}

describe('team REST role enforcement', () => {
  function startTeam() {
    const { host, spawn } = makeTeamHost();
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: auth(),
      nodeId: 'A',
      team: { nodeId: 'A', host, spawn },
    });
    gateways.push(gateway);
    return gateway;
  }

  it('allows GET for read tokens and rejects mutations', async () => {
    const gateway = startTeam();

    const list = await fetch(`${gateway.url}/v1/team/agents`, {
      headers: authHeader('reader'),
    });
    expect(list.status).toBe(200);

    const spawn = await fetch(`${gateway.url}/v1/team/agents`, {
      method: 'POST',
      headers: { ...authHeader('reader'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Worker' }),
    });
    expect(spawn.status).toBe(403);
    expect(((await spawn.json()) as { error: { code: string } }).error.code).toBe('forbidden');

    const cancel = await fetch(`${gateway.url}/v1/team/agents/worker/cancel`, {
      method: 'POST',
      headers: authHeader('reader'),
    });
    expect(cancel.status).toBe(403);

    const close = await fetch(`${gateway.url}/v1/team/agents/worker/close`, {
      method: 'POST',
      headers: authHeader('reader'),
    });
    expect(close.status).toBe(403);
  });

  it('allows write tokens to spawn/cancel/close', async () => {
    const gateway = startTeam();

    const spawn = await fetch(`${gateway.url}/v1/team/agents`, {
      method: 'POST',
      headers: { ...authHeader('writer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Worker' }),
    });
    expect(spawn.status).toBe(201);

    const cancel = await fetch(`${gateway.url}/v1/team/agents/worker/cancel`, {
      method: 'POST',
      headers: authHeader('writer'),
    });
    expect(cancel.status).toBe(200);

    const close = await fetch(`${gateway.url}/v1/team/agents/worker/close`, {
      method: 'POST',
      headers: authHeader('writer'),
    });
    expect(close.status).toBe(200);
  });

  it('keeps the default-tenant/admin boundary', async () => {
    const gateway = startTeam();

    for (const token of ['b-reader', 'b-writer']) {
      const res = await fetch(`${gateway.url}/v1/team/agents`, {
        headers: authHeader(token),
      });
      expect(res.status).toBe(403);
    }

    const adminGet = await fetch(`${gateway.url}/v1/team/agents`, {
      headers: authHeader('admin'),
    });
    expect(adminGet.status).toBe(200);

    const adminSpawn = await fetch(`${gateway.url}/v1/team/agents`, {
      method: 'POST',
      headers: { ...authHeader('admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AdminWorker' }),
    });
    expect(adminSpawn.status).toBe(201);
  });
});
