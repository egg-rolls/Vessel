import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { FeishuStatus } from '../src/feishu';
import type { Gateway } from '../src/gateway';
import type { GatewayAuthLike } from '../src/tenant';
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

function channelOf(body: Record<string, unknown>): FeishuStatus {
  return (body.result as { channel: FeishuStatus }).channel;
}

describe('per-tenant feishu control plane', () => {
  it('keeps default tenant on the legacy global channel', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      feishu: { status: () => feishuStatus('gl_***') },
    });
    gateways.push(gateway);

    expect(channelOf(await rpc(gateway, 'legacy', 'feishu.status')).appIdMasked).toBe('gl_***');

    const feishu = await rest(gateway, 'legacy', '/v1/channels/feishu');
    expect(feishu.status).toBe(200);
    expect((feishu.body.channel as FeishuStatus).appIdMasked).toBe('gl_***');
  });

  it('falls back to feishuFor(defaultTenantId) when the global channel is absent', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      feishuFor: (tenantId) =>
        tenantId === 'default' ? { status: () => feishuStatus('df_***') } : undefined,
    });
    gateways.push(gateway);

    expect(channelOf(await rpc(gateway, 'legacy', 'feishu.status')).appIdMasked).toBe('df_***');
    expect(gateway.protocol.features).toContain('feishu');
  });

  it('routes each non-default tenant to its own channel and never to the global one', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      feishu: { status: () => feishuStatus('gl_***') },
      feishuFor: (tenantId) =>
        tenantId === 'a'
          ? { status: () => feishuStatus('aa_***') }
          : tenantId === 'b'
            ? { status: () => feishuStatus('bb_***') }
            : undefined,
    });
    gateways.push(gateway);

    expect(channelOf(await rpc(gateway, 'a', 'feishu.status')).appIdMasked).toBe('aa_***');
    expect(channelOf(await rpc(gateway, 'b', 'feishu.status')).appIdMasked).toBe('bb_***');

    const feishuA = await rest(gateway, 'a', '/v1/channels/feishu');
    expect((feishuA.body.channel as FeishuStatus).appIdMasked).toBe('aa_***');
    const feishuB = await rest(gateway, 'admin', '/v1/channels/feishu?tenant_id=b');
    expect((feishuB.body.channel as FeishuStatus).appIdMasked).toBe('bb_***');
  });

  it('returns forbidden / 403 for unconfigured non-default tenants instead of the global channel', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      feishu: { status: () => feishuStatus('gl_***') },
    });
    gateways.push(gateway);

    expect(errorCode(await rpc(gateway, 'a', 'feishu.status'))).toBe('forbidden');

    const direct = await rest(gateway, 'a', '/v1/channels/feishu');
    expect(direct.status).toBe(403);
    expect(errorCode(direct.body)).toBe('forbidden');
    const viaAdmin = await rest(gateway, 'admin', '/v1/channels/feishu?tenant_id=a');
    expect(viaAdmin.status).toBe(403);
    expect(errorCode(viaAdmin.body)).toBe('forbidden');

    // default tenant 仍可使用全局 channel。
    expect(channelOf(await rpc(gateway, 'legacy', 'feishu.status')).appIdMasked).toBe('gl_***');
  });

  it('does not fall back to the global channel for a tenant literally named default when config default is acme', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      token: 'legacy',
      auth: authFor(),
      defaultTenantId: 'acme',
      feishu: { status: () => feishuStatus('gl_***') },
      feishuFor: (tenantId) =>
        tenantId === 'acme' ? { status: () => feishuStatus('ac_***') } : undefined,
    });
    gateways.push(gateway);

    expect(errorCode(await rpc(gateway, 'default', 'feishu.status'))).toBe('forbidden');
    const feishu = await rest(gateway, 'default', '/v1/channels/feishu');
    expect(feishu.status).toBe(403);

    // acme（defaultTenantId）仍先用全局实例。
    expect(channelOf(await rpc(gateway, 'acme', 'feishu.status')).appIdMasked).toBe('gl_***');
  });

  it('adds tenant_id to the frozen feishu.status schema', () => {
    const gateway = createGateway({ events: new MemoryEventStream(), token: 'legacy' });
    gateways.push(gateway);
    const method = gateway
      .manifest()
      .methods.find((candidate) => candidate.name === 'feishu.status');
    const properties = (method?.params_schema as { properties?: Record<string, unknown> })
      ?.properties;
    expect(properties?.tenant_id).toBeDefined();
  });
});
