import { beforeEach, describe, expect, test } from 'bun:test';
import type { GatewayClient } from '../src/gateway/client';
import type { NodeView } from '../src/gateway/NodeProvider';
import type {
  DurableRunSummary,
  HealthResponse,
  RunEvent,
  RunStatus,
  TaskEntry,
  TenantInfo,
} from '../src/gateway/types';
import { resourceData } from '../src/state/useResource';
import { useRunStore } from '../src/stores/runStore';
import { useTenantStore } from '../src/stores/tenantStore';

const nodeA: NodeView = { name: 'Alpha', nodeId: 'node-a', url: 'http://a', current: true };
const nodeB: NodeView = { name: 'Beta', nodeId: 'node-b', url: 'http://b', current: false };

function run(id: string, overrides: Partial<RunStatus> = {}): RunStatus {
  return { run_id: id, session_id: 's1', status: 'running', ...overrides };
}

function durable(id: string): DurableRunSummary {
  return { run_id: id, session_id: 's1', status: 'interrupted', updated_at: 1 };
}

function task(id: string): TaskEntry {
  return {
    id,
    title: id,
    assignee: 'a1',
    status: 'queued',
    artifact_refs: [],
    since: 1,
  };
}

function health(): HealthResponse {
  return {
    status: 'ok',
    clients: 0,
    latest_seq: 0,
    protocol: { name: 'vessel.gateway', version: 1, min: 1, features: [] },
    node: {
      node_id: 'node-a',
      name: 'Alpha',
      pid: 1,
      started_at: 1,
      endpoint: 'http://a',
      role: 'standalone',
      status: 'idle',
      capabilities: { tools: [], max_concurrency: 1, protocol: 1 },
    },
    started_at: 1,
    tenant_id: 'default',
  };
}

function event(id: string): RunEvent {
  return { type: 'run.failed', run_id: id, data: {}, ts: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runStore', () => {
  beforeEach(() => {
    useRunStore.getState().reset();
  });

  test('loads live and durable runs into separate per-node slots', async () => {
    const client = {
      listRuns: async () => [run('live-1')],
      listDurableRuns: async () => [durable('durable-1')],
    } as unknown as GatewayClient;

    await useRunStore.getState().loadRuns(client, nodeA, 'live');
    await useRunStore.getState().loadRuns(client, nodeA, 'durable');

    const entry = useRunStore.getState().runsByNode['node-a'];
    expect(resourceData(entry?.live)?.map((item) => item.run_id)).toEqual(['live-1']);
    expect(resourceData(entry?.durable)?.map((item) => item.run_id)).toEqual(['durable-1']);

    // A different node keeps its own slot.
    const otherClient = {
      listRuns: async () => [run('live-b')],
    } as unknown as GatewayClient;
    await useRunStore.getState().loadRuns(otherClient, nodeB, 'live');
    expect(
      resourceData(useRunStore.getState().runsByNode['node-b']?.live)?.map((item) => item.run_id),
    ).toEqual(['live-b']);
    expect(
      resourceData(useRunStore.getState().runsByNode['node-a']?.live)?.map((item) => item.run_id),
    ).toEqual(['live-1']);
  });

  test('an older response cannot overwrite a newer one', async () => {
    const first = deferred<RunStatus[]>();
    const second = deferred<RunStatus[]>();
    let calls = 0;
    const client = {
      listRuns: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    } as unknown as GatewayClient;

    const firstLoad = useRunStore.getState().loadRuns(client, nodeA, 'live');
    const secondLoad = useRunStore.getState().loadRuns(client, nodeA, 'live');

    second.resolve([run('new')]);
    await secondLoad;
    first.resolve([run('old')]);
    await firstLoad;

    expect(
      resourceData(useRunStore.getState().runsByNode['node-a']?.live)?.map((item) => item.run_id),
    ).toEqual(['new']);
  });

  test('keeps stale runs when a refresh fails', async () => {
    const okClient = {
      listRuns: async () => [run('live-1')],
    } as unknown as GatewayClient;
    await useRunStore.getState().loadRuns(okClient, nodeA, 'live');

    const failingClient = {
      listRuns: async () => {
        throw new Error('offline');
      },
    } as unknown as GatewayClient;
    await useRunStore.getState().loadRuns(failingClient, nodeA, 'live');

    const state = useRunStore.getState().runsByNode['node-a']?.live;
    expect(state?.status).toBe('error');
    if (state?.status !== 'error') throw new Error('expected error state');
    expect(state.error).toBe('offline');
    expect(state.data?.map((item) => item.run_id)).toEqual(['live-1']);
  });

  test('loads tasks per node', async () => {
    const client = {
      listTasks: async () => [task('t1')],
    } as unknown as GatewayClient;

    await useRunStore.getState().loadTasks(client, nodeA);

    expect(
      resourceData(useRunStore.getState().tasksByNode['node-a'])?.map((item) => item.id),
    ).toEqual(['t1']);
    expect(useRunStore.getState().tasksByNode['node-b']).toBeUndefined();
  });

  test('diagnostics health and events load and fail independently', async () => {
    const okClient = {
      getHealth: async () => health(),
      readEvents: async () => [event('r1')],
    } as unknown as GatewayClient;
    await useRunStore.getState().loadDiagnostics(okClient, nodeA);

    let entry = useRunStore.getState().diagnosticsByNode['node-a'];
    expect(entry?.health.status).toBe('success');
    expect(resourceData(entry?.events)?.map((item) => item.run_id)).toEqual(['r1']);

    const failingEvents = {
      getHealth: async () => health(),
      readEvents: async () => {
        throw new Error('events-down');
      },
    } as unknown as GatewayClient;
    await useRunStore.getState().loadDiagnostics(failingEvents, nodeA, 'events');

    entry = useRunStore.getState().diagnosticsByNode['node-a'];
    expect(entry?.health.status).toBe('success');
    expect(entry?.events.status).toBe('error');
  });

  test('targeted diagnostics loads only touch the requested source', async () => {
    let healthCalls = 0;
    let eventCalls = 0;
    const client = {
      getHealth: async () => {
        healthCalls += 1;
        return health();
      },
      readEvents: async () => {
        eventCalls += 1;
        return [];
      },
    } as unknown as GatewayClient;

    await useRunStore.getState().loadDiagnostics(client, nodeA, 'health');
    expect(healthCalls).toBe(1);
    expect(eventCalls).toBe(0);

    await useRunStore.getState().loadDiagnostics(client, nodeA, 'events');
    expect(healthCalls).toBe(1);
    expect(eventCalls).toBe(1);
  });
});

describe('tenantStore', () => {
  beforeEach(() => {
    useTenantStore.getState().reset();
  });

  const tenants: TenantInfo[] = [
    { tenant_id: 'default', status: 'active', created_at: 1 },
    { tenant_id: 'team-a', status: 'active', created_at: 2 },
  ];

  test('loads tenants and tracks the selected tenant', async () => {
    const client = {
      listTenants: async () => tenants,
    } as unknown as GatewayClient;

    await useTenantStore.getState().loadTenants(client);
    expect(resourceData(useTenantStore.getState().tenants)?.map((item) => item.tenant_id)).toEqual([
      'default',
      'team-a',
    ]);

    useTenantStore.getState().select('team-a');
    expect(useTenantStore.getState().currentId).toBe('team-a');
  });

  test('keeps stale tenants when a refresh fails', async () => {
    await useTenantStore.getState().loadTenants({
      listTenants: async () => tenants,
    } as unknown as GatewayClient);

    let calls = 0;
    const failing = {
      listTenants: async () => {
        calls += 1;
        throw new Error('forbidden');
      },
    } as unknown as GatewayClient;
    await useTenantStore.getState().loadTenants(failing);

    const state = useTenantStore.getState().tenants;
    expect(state.status).toBe('error');
    expect(resourceData(state)).toHaveLength(2);
    expect(calls).toBe(1);
  });
});
