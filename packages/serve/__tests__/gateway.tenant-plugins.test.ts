import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    a: { tenant_id: 'a', role: 'write' },
    b: { tenant_id: 'b', role: 'write' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

function hostWithTool(name: string): MemoryPluginHost {
  const host = new MemoryPluginHost();
  host.registerTool({
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' },
    handler: async () => name,
  });
  return host;
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

describe('per-tenant capabilities and plugins', () => {
  it('does not mix tools or plugins between tenants', async () => {
    const events = new MemoryEventStream();
    const pluginHosts: Record<string, MemoryPluginHost> = {
      a: hostWithTool('tool_a'),
      b: hostWithTool('tool_b'),
    };
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      pluginHost: hostWithTool('tool_default'),
      pluginHostFor: (tenantId) => pluginHosts[tenantId],
      plugins: () => [{ name: 'global-plugin', enabled: true }],
      pluginsFor: (tenantId) => [{ name: `plugin_${tenantId}`, enabled: tenantId === 'a' }],
    });
    gateways.push(gateway);

    const capsA = (await rpc(gateway, 'a', 'capabilities.list')).result as {
      tools: Array<{ name: string }>;
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    const capsB = (await rpc(gateway, 'b', 'capabilities.list')).result as {
      tools: Array<{ name: string }>;
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    expect(capsA.tools.map((tool) => tool.name)).toEqual(['tool_a']);
    expect(capsB.tools.map((tool) => tool.name)).toEqual(['tool_b']);
    expect(capsA.plugins).toEqual([{ name: 'plugin_a', enabled: true }]);
    expect(capsB.plugins).toEqual([{ name: 'plugin_b', enabled: false }]);

    const listA = (await rpc(gateway, 'a', 'plugins.list')).result as {
      plugins: Array<{ name: string }>;
    };
    const listB = (await rpc(gateway, 'b', 'plugins.list')).result as {
      plugins: Array<{ name: string }>;
    };
    expect(listA.plugins.map((plugin) => plugin.name)).toEqual(['plugin_a']);
    expect(listB.plugins.map((plugin) => plugin.name)).toEqual(['plugin_b']);

    // 默认 tenant 兼容入口仍走全局 host / plugins
    const defaultManifest = gateway.manifest();
    expect(defaultManifest.tools.map((tool) => tool.name)).toEqual(['tool_default']);
    expect(defaultManifest.plugins).toEqual([{ name: 'plugin_default', enabled: false }]);
  });

  it('falls back to global plugins when pluginsFor is absent', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authFor(),
      plugins: () => [{ name: 'global', enabled: true }],
    });
    gateways.push(gateway);
    const result = (await rpc(gateway, 'a', 'plugins.list')).result as {
      plugins: Array<{ name: string }>;
    };
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(['global']);
  });
});

describe('per-tenant trace and session data', () => {
  it('passes the request tenant to readEvents and deleteSessionData', async () => {
    const events = new MemoryEventStream();
    const traceCalls: Array<{ filter: Record<string, unknown>; tenantId?: string }> = [];
    const deleteCalls: Array<{ sessionId: string; tenantId?: string }> = [];
    const gateway = startGateway({
      events,
      port: 0,
      token: 'legacy',
      auth: authFor(),
      trace: {
        readEvents: async (filter, tenantId) => {
          traceCalls.push({ filter, ...(tenantId !== undefined ? { tenantId } : {}) });
          return [
            {
              type: `trace.${tenantId}`,
              run_id: 'r1',
              data: { tenant: tenantId },
              ts: 1,
              ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
            },
          ];
        },
      },
      sessionData: {
        deleteSessionData: async (sessionId, tenantId) => {
          deleteCalls.push({ sessionId, ...(tenantId !== undefined ? { tenantId } : {}) });
          return {
            sessions_deleted: 1,
            runs_deleted: tenantId === 'a' ? 1 : 2,
            events_deleted: tenantId === 'a' ? 3 : 4,
          };
        },
      },
    });
    gateways.push(gateway);

    const listA = (await rpc(gateway, 'a', 'events.list', { run_id: 'r1' })).result as {
      events: Array<{ type: string; data: { tenant: string } }>;
    };
    const listB = (await rpc(gateway, 'b', 'events.list', { run_id: 'r1' })).result as {
      events: Array<{ type: string; data: { tenant: string } }>;
    };
    expect(listA.events.map((event) => event.type)).toEqual(['trace.a']);
    expect(listB.events.map((event) => event.type)).toEqual(['trace.b']);
    expect(traceCalls.map((call) => call.tenantId)).toEqual(['a', 'b']);

    const delA = (await rpc(gateway, 'a', 'sessions.delete', { session_id: 's1' })).result as {
      runs_deleted: number;
      events_deleted: number;
    };
    const delB = (await rpc(gateway, 'b', 'sessions.delete', { session_id: 's2' })).result as {
      runs_deleted: number;
      events_deleted: number;
    };
    expect(delA).toMatchObject({ runs_deleted: 1, events_deleted: 3 });
    expect(delB).toMatchObject({ runs_deleted: 2, events_deleted: 4 });
    expect(deleteCalls).toEqual([
      { sessionId: 's1', tenantId: 'a' },
      { sessionId: 's2', tenantId: 'b' },
    ]);
  });
});
