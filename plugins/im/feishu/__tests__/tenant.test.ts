import { afterEach, describe, expect, it } from 'bun:test';
import {
  MemoryEventStream,
  MemoryPluginHost,
  MemoryRunStore,
  MemorySessionBackend,
} from '@vessel-agent/core';
import { createFeishuPlugin } from '../src/index.js';
import type { FeishuConfig, FeishuPlugin } from '../src/types.js';
import { FakeTransport, textMessage, textProvider, waitFor } from './fixtures/fake-transport.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function makePlugin(
  tenantId: string | undefined,
  overrides: Partial<FeishuConfig> = {},
): { plugin: FeishuPlugin; transport: FakeTransport; events: MemoryEventStream } {
  const transport = new FakeTransport();
  const events = new MemoryEventStream();
  const plugin = createFeishuPlugin({
    config: {
      enabled: true,
      appId: 'app_1234',
      appSecret: 'secret_value',
      ...overrides,
    },
    ...(tenantId !== undefined ? { tenantId } : {}),
    events,
    provider: textProvider('reply'),
    model: 'test-model',
    pluginHost: new MemoryPluginHost(),
    session: new MemorySessionBackend(),
    runStore: new MemoryRunStore(),
    transport,
    env: {},
  });
  cleanups.push(async () => {
    await plugin.stop();
  });
  return { plugin, transport, events };
}

describe('feishu tenant scope', () => {
  it('stamps tenant_id on channel and runner events and status', async () => {
    const { plugin, transport, events } = makePlugin('acme');
    await plugin.start();
    transport.emit(textMessage('oc_chat', 'hello'));
    await waitFor(() => transport.replies.length === 1);

    expect(plugin.status().tenant_id).toBe('acme');
    const history = events.getHistory();
    expect(history.length).toBeGreaterThan(0);
    for (const event of history) expect(event.tenant_id).toBe('acme');
    expect(history.some((event) => event.type === 'channel.feishu.reply.sent')).toBe(true);
  });

  it('keeps instances isolated and does not read ambient env when env is empty', async () => {
    process.env.VESSEL_FEISHU_APP_ID = 'ambient_app';
    const tenantA = makePlugin('tenant_a');
    const tenantB = makePlugin('tenant_b');
    try {
      await tenantA.plugin.start();
      await tenantB.plugin.start();
      tenantA.transport.emit(textMessage('oc_a', 'a'));
      tenantB.transport.emit(textMessage('oc_b', 'b'));
      await waitFor(() => tenantA.transport.replies.length === 1);
      await waitFor(() => tenantB.transport.replies.length === 1);

      expect(tenantA.plugin.status()).toMatchObject({
        tenant_id: 'tenant_a',
        appIdMasked: 'app_***',
      });
      expect(tenantB.plugin.status()).toMatchObject({
        tenant_id: 'tenant_b',
        appIdMasked: 'app_***',
      });
      for (const event of tenantA.events.getHistory()) {
        expect(event.tenant_id).toBe('tenant_a');
      }
      for (const event of tenantB.events.getHistory()) {
        expect(event.tenant_id).toBe('tenant_b');
      }
    } finally {
      delete process.env.VESSEL_FEISHU_APP_ID;
    }
  });

  it('keeps 0.4 envelope and status when tenantId is omitted', async () => {
    const { plugin, events } = makePlugin(undefined);
    await plugin.start();
    expect('tenant_id' in plugin.status()).toBe(false);
    for (const event of events.getHistory()) expect('tenant_id' in event).toBe(false);
  });

  it('rejects an invalid tenant id at construction', () => {
    expect(() => makePlugin('Bad Tenant')).toThrow(/invalid tenant id/);
  });
});
