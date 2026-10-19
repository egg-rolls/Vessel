import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { FeishuStatus } from '../src/feishu';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
import type {
  WorkflowGatewayOptions,
  WorkflowOutcome,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from '../src/workflow';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: '*', role: 'admin' },
    a: { tenant_id: 'a', role: 'write' },
    b: { tenant_id: 'b', role: 'write' },
    default: { tenant_id: 'default', role: 'write' },
    acme: { tenant_id: 'acme', role: 'admin' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function detail(
  id: string,
  status: WorkflowRunStatus,
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail {
  return {
    workflow_run_id: id,
    workflow_name: 'release-check',
    status,
    step_count: 1,
    completed_steps: 0,
    started_at: 1000,
    updated_at: 2000,
    definition_path: `./workflows/${id}.yaml`,
    inputs: {},
    steps: [],
    ...overrides,
  };
}

interface FakeEngine {
  engine: WorkflowGatewayOptions;
  calls: {
    list: number;
    get: string[];
    start: string[];
    resume: string[];
    cancel: string[];
    resolve: string[];
  };
  runs: Map<string, WorkflowRunDetail>;
}

function makeEngine(tag: string, initial: WorkflowRunDetail[] = []): FakeEngine {
  const calls: FakeEngine['calls'] = {
    list: 0,
    get: [],
    start: [],
    resume: [],
    cancel: [],
    resolve: [],
  };
  const runs = new Map(initial.map((run) => [run.workflow_run_id, run]));
  const engine: WorkflowGatewayOptions = {
    async listRuns() {
      calls.list += 1;
      return [...runs.values()];
    },
    async getRun(id) {
      calls.get.push(id);
      return runs.get(id) ?? null;
    },
    async start(path) {
      calls.start.push(path);
      const id = `${tag}_started`;
      runs.set(id, detail(id, 'running'));
      return {
        workflowRunId: id,
        done: Promise.resolve<WorkflowOutcome>({ workflow_run_id: id, status: 'completed' }),
      };
    },
    async resume(id) {
      calls.resume.push(id);
      return {
        workflowRunId: id,
        done: Promise.resolve<WorkflowOutcome>({ workflow_run_id: id, status: 'running' }),
      };
    },
    async cancel(id) {
      calls.cancel.push(id);
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, status: 'cancelled' });
    },
    resolveDefinition(name) {
      calls.resolve.push(name);
      return name === 'missing' ? undefined : `/${tag}/${name}.yaml`;
    },
  };
  return { engine, calls, runs };
}

function feishuStatus(appIdMasked: string): FeishuStatus {
  return { connected: true, appIdMasked, active_chats: 0, queued_messages: 0 };
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

async function rest(
  gateway: Gateway,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${gateway.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? '';
}

function workflowIds(body: Record<string, unknown>): string[] {
  return ((body.result as { workflows?: Array<{ workflow_run_id: string }> }).workflows ?? []).map(
    (run) => run.workflow_run_id,
  );
}

function restWorkflowIds(body: Record<string, unknown>): string[] {
  return ((body.workflows ?? []) as Array<{ workflow_run_id: string }>).map(
    (run) => run.workflow_run_id,
  );
}

describe('per-tenant workflow / feishu control plane', () => {
  it('keeps default tenant on the legacy global engines', async () => {
    const global = makeEngine('global', [detail('global_1', 'running')]);
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      workflows: global.engine,
      feishu: { status: () => feishuStatus('gl_***') },
    });
    gateways.push(gateway);

    expect(workflowIds(await rpc(gateway, 'legacy', 'workflow.list'))).toEqual(['global_1']);
    const channel = (await rpc(gateway, 'legacy', 'feishu.status')).result as {
      channel: FeishuStatus;
    };
    expect(channel.channel.appIdMasked).toBe('gl_***');

    const listed = await rest(gateway, 'legacy', '/v1/workflows');
    expect(listed.status).toBe(200);
    const feishu = await rest(gateway, 'legacy', '/v1/channels/feishu');
    expect(feishu.status).toBe(200);
    expect((feishu.body.channel as FeishuStatus).appIdMasked).toBe('gl_***');
  });

  it('falls back to *For(defaultTenantId) when globals are absent', async () => {
    const fallback = makeEngine('default', [detail('default_1', 'running')]);
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      workflowsFor: (tenantId) => (tenantId === 'default' ? fallback.engine : undefined),
      feishuFor: (tenantId) =>
        tenantId === 'default' ? { status: () => feishuStatus('df_***') } : undefined,
    });
    gateways.push(gateway);

    expect(workflowIds(await rpc(gateway, 'legacy', 'workflow.list'))).toEqual(['default_1']);
    const channel = (await rpc(gateway, 'legacy', 'feishu.status')).result as {
      channel: FeishuStatus;
    };
    expect(channel.channel.appIdMasked).toBe('df_***');
    expect(gateway.protocol.features).toContain('workflow');
    expect(gateway.protocol.features).toContain('feishu');
  });

  it('routes each non-default tenant to its own engine and never to the global one', async () => {
    const global = makeEngine('global', [detail('global_1', 'running')]);
    const engineA = makeEngine('a', [
      detail('a_1', 'running'),
      detail('a_cancel', 'running'),
      detail('a_resume', 'interrupted'),
    ]);
    const engineB = makeEngine('b', [detail('b_1', 'running'), detail('b_resume', 'interrupted')]);
    const engines: Record<string, FakeEngine> = { a: engineA, b: engineB };
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      workflows: global.engine,
      workflowsFor: (tenantId) => engines[tenantId]?.engine,
      feishu: { status: () => feishuStatus('gl_***') },
      feishuFor: (tenantId) =>
        tenantId === 'a'
          ? { status: () => feishuStatus('aa_***') }
          : tenantId === 'b'
            ? { status: () => feishuStatus('bb_***') }
            : undefined,
    });
    gateways.push(gateway);

    expect(workflowIds(await rpc(gateway, 'a', 'workflow.list'))).toEqual([
      'a_1',
      'a_cancel',
      'a_resume',
    ]);
    expect(workflowIds(await rpc(gateway, 'b', 'workflow.list'))).toEqual(['b_1', 'b_resume']);

    expect((await rpc(gateway, 'b', 'workflow.get', { workflow_run_id: 'b_1' })).ok).toBe(true);
    expect(engineB.calls.get).toContain('b_1');

    expect((await rpc(gateway, 'a', 'workflow.start', { name: 'deploy' })).ok).toBe(true);
    expect(engineA.calls.resolve).toEqual(['deploy']);
    expect(engineA.calls.start).toEqual(['/a/deploy.yaml']);

    expect((await rpc(gateway, 'b', 'workflow.resume', { workflow_run_id: 'b_resume' })).ok).toBe(
      true,
    );
    expect(engineB.calls.resume).toEqual(['b_resume']);

    expect((await rpc(gateway, 'a', 'workflow.cancel', { workflow_run_id: 'a_cancel' })).ok).toBe(
      true,
    );
    expect(engineA.calls.cancel).toEqual(['a_cancel']);

    expect(
      ((await rpc(gateway, 'a', 'feishu.status')).result as { channel: FeishuStatus }).channel
        .appIdMasked,
    ).toBe('aa_***');
    expect(
      ((await rpc(gateway, 'b', 'feishu.status')).result as { channel: FeishuStatus }).channel
        .appIdMasked,
    ).toBe('bb_***');

    expect(global.calls.list).toBe(0);
    expect(global.calls.get).toEqual([]);
    expect(global.calls.start).toEqual([]);
    expect(global.calls.resume).toEqual([]);
    expect(global.calls.cancel).toEqual([]);

    // REST：principal tenant 与 admin query tenant_id 都走对应 engine。
    const restA = await rest(gateway, 'a', '/v1/workflows');
    expect(restWorkflowIds(restA.body)).toEqual(['a_1', 'a_cancel', 'a_resume', 'a_started']);
    const restB = await rest(gateway, 'admin', '/v1/workflows?tenant_id=b');
    expect(restWorkflowIds(restB.body)).toEqual(['b_1', 'b_resume']);
    const runA = await rest(gateway, 'admin', '/v1/workflows/run', {
      method: 'POST',
      body: JSON.stringify({ name: 'deploy', tenant_id: 'a' }),
    });
    expect(runA.status).toBe(202);
    expect(engineA.calls.start).toEqual(['/a/deploy.yaml', '/a/deploy.yaml']);
    const feishuA = await rest(gateway, 'a', '/v1/channels/feishu');
    expect((feishuA.body.channel as FeishuStatus).appIdMasked).toBe('aa_***');
    const feishuB = await rest(gateway, 'admin', '/v1/channels/feishu?tenant_id=b');
    expect((feishuB.body.channel as FeishuStatus).appIdMasked).toBe('bb_***');
  });

  it('returns forbidden / 403 for unconfigured non-default tenants instead of the global engine', async () => {
    const global = makeEngine('global', [detail('global_1', 'running')]);
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      workflows: global.engine,
      feishu: { status: () => feishuStatus('gl_***') },
    });
    gateways.push(gateway);

    for (const [method, params] of [
      ['workflow.list', undefined],
      ['workflow.get', { workflow_run_id: 'global_1' }],
      ['workflow.start', { name: 'deploy' }],
      ['workflow.resume', { workflow_run_id: 'global_1' }],
      ['workflow.cancel', { workflow_run_id: 'global_1' }],
    ] as const) {
      const body = await rpc(gateway, 'a', method, params);
      expect(body.ok).toBe(false);
      expect(errorCode(body)).toBe('forbidden');
    }
    expect(errorCode(await rpc(gateway, 'a', 'feishu.status'))).toBe('forbidden');

    for (const [path, init] of [
      ['/v1/workflows', {}],
      ['/v1/workflows/global_1', {}],
      ['/v1/workflows/run', { method: 'POST', body: JSON.stringify({ name: 'deploy' }) }],
      ['/v1/workflows/global_1/resume', { method: 'POST' }],
      ['/v1/workflows/global_1/cancel', { method: 'POST' }],
    ] as const) {
      const response = await rest(gateway, 'a', path, init as RequestInit);
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('forbidden');
    }
    for (const path of ['/v1/workflows?tenant_id=a', '/v1/channels/feishu?tenant_id=a']) {
      const response = await rest(gateway, 'admin', path);
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('forbidden');
    }

    expect(global.calls.list).toBe(0);
    expect(global.calls.get).toEqual([]);
    // default tenant 仍可使用全局 engine。
    expect(workflowIds(await rpc(gateway, 'legacy', 'workflow.list'))).toEqual(['global_1']);
  });

  it('does not fall back to the global engine for a tenant literally named default when config default is acme', async () => {
    const global = makeEngine('global', [detail('global_1', 'running')]);
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      defaultTenantId: 'acme',
      workflows: global.engine,
      workflowsFor: (tenantId) => (tenantId === 'acme' ? makeEngine('acme').engine : undefined),
      feishu: { status: () => feishuStatus('gl_***') },
      feishuFor: (tenantId) =>
        tenantId === 'acme' ? { status: () => feishuStatus('ac_***') } : undefined,
    });
    gateways.push(gateway);

    expect(errorCode(await rpc(gateway, 'default', 'workflow.list'))).toBe('forbidden');
    expect(errorCode(await rpc(gateway, 'default', 'feishu.status'))).toBe('forbidden');

    const list = await rest(gateway, 'default', '/v1/workflows');
    expect(list.status).toBe(403);
    expect(errorCode(list.body)).toBe('forbidden');
    const feishu = await rest(gateway, 'default', '/v1/channels/feishu');
    expect(feishu.status).toBe(403);

    // acme（defaultTenantId）仍先用全局实例。
    expect(workflowIds(await rpc(gateway, 'acme', 'workflow.list'))).toEqual(['global_1']);
    const adminDefault = await rest(gateway, 'admin', '/v1/workflows?tenant_id=default');
    expect(adminDefault.status).toBe(403);
  });

  it('adds tenant_id to the frozen schemas of workflow and feishu methods', () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 'legacy' });
    gateways.push(gateway);
    const methods = gateway.manifest().methods;
    for (const name of [
      'workflow.list',
      'workflow.get',
      'workflow.start',
      'workflow.resume',
      'workflow.cancel',
      'feishu.status',
    ]) {
      const method = methods.find((candidate) => candidate.name === name);
      const properties = (method?.params_schema as { properties?: Record<string, unknown> })
        ?.properties;
      expect(properties?.tenant_id).toBeDefined();
    }
  });
});
