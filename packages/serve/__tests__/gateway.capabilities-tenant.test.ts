import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

function authForB(): GatewayAuthLike {
  return {
    configured: true,
    authenticate: (token) => (token === 'b' ? { tenant_id: 'b', role: 'write' } : null),
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

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? '';
}

describe('capabilities.list tenant tools isolation', () => {
  it('returns empty tools/plugins for an unconfigured tenant when pluginHostFor is injected', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
      pluginHost: hostWithTool('default_tool'),
      // b 未配置；只有 a 有 host
      pluginHostFor: (tenantId) => (tenantId === 'a' ? hostWithTool('tenant_a_tool') : undefined),
      plugins: () => [{ name: 'global-plugin', enabled: true }],
      pluginsFor: (tenantId) => (tenantId === 'a' ? [{ name: 'a-plugin', enabled: true }] : []),
    });
    gateways.push(gateway);

    const caps = (await rpc(gateway, 'b', 'capabilities.list')).result as {
      tools: Array<{ name: string }>;
      plugins: Array<{ name: string }>;
    };
    expect(caps.tools).toEqual([]);
    expect(caps.plugins).toEqual([]);

    const tools = await rpc(gateway, 'b', 'tools.list');
    expect(tools.ok).toBe(false);
    expect(errorCode(tools)).toBe('forbidden');

    // default tenant 仍使用全局 host，不泄漏 tenant a
    const defaultCaps = gateway.manifest();
    expect(defaultCaps.tools.map((tool) => tool.name)).toEqual(['default_tool']);
  });

  it('keeps the global fallback when pluginHostFor is not injected (single tenant/legacy)', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
      pluginHost: hostWithTool('legacy_tool'),
    });
    gateways.push(gateway);

    const caps = (await rpc(gateway, 'b', 'capabilities.list')).result as {
      tools: Array<{ name: string }>;
      plugins: Array<{ name: string }>;
    };
    expect(caps.tools.map((tool) => tool.name)).toEqual(['legacy_tool']);
    expect(caps.plugins).toEqual([]);
  });

  it('uses the per-tenant host when configured', async () => {
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForB(),
      pluginHost: hostWithTool('default_tool'),
      pluginHostFor: (tenantId) => (tenantId === 'b' ? hostWithTool('tenant_b_tool') : undefined),
    });
    gateways.push(gateway);

    const caps = (await rpc(gateway, 'b', 'capabilities.list')).result as {
      tools: Array<{ name: string }>;
    };
    expect(caps.tools.map((tool) => tool.name)).toEqual(['tenant_b_tool']);
  });
});
