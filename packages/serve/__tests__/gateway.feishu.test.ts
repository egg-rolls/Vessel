import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import type { FeishuStatus } from '../src/feishu';
import type { Gateway } from '../src/gateway';
import { createGateway } from './helpers';

function status(overrides: Partial<FeishuStatus> = {}): FeishuStatus {
  return {
    connected: true,
    appIdMasked: 'cli_***',
    active_chats: 2,
    queued_messages: 1,
    ...overrides,
  };
}

describe('gateway feishu channel endpoint', () => {
  const gateways: Gateway[] = [];

  const start = (statusFn?: () => FeishuStatus): Gateway => {
    const gw = createGateway({
      events: new MemoryEventStream(),
      ...(statusFn ? { feishu: { status: statusFn } } : {}),
    });
    gateways.push(gw);
    return gw;
  };

  const auth = (gw: Gateway): Record<string, string> => ({
    Authorization: `Bearer ${gw.token}`,
  });

  afterEach(() => {
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('returns channel_disabled when not injected', async () => {
    const gw = start();
    const res = await fetch(`${gw.url}/v1/channels/feishu`, { headers: auth(gw) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('channel_disabled');
  });

  it('returns the frozen status fields', async () => {
    const gw = start(() => ({ ...status(), app_secret: 'must-not-leak' }) as FeishuStatus);
    const res = await fetch(`${gw.url}/v1/channels/feishu`, { headers: auth(gw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: FeishuStatus };
    expect(body.channel).toEqual(status());
    expect((body.channel as unknown as Record<string, unknown>).app_secret).toBeUndefined();
  });

  it('re-masks an unmasked app id', async () => {
    const gw = start(() => status({ appIdMasked: 'cli_abc123' }));
    const res = await fetch(`${gw.url}/v1/channels/feishu`, { headers: auth(gw) });
    const body = (await res.json()) as { channel: FeishuStatus };
    expect(body.channel.appIdMasked).toBe('cli_***');
  });

  it('maps provider failures to internal', async () => {
    const gw = start(() => {
      throw new Error('boom');
    });
    const res = await fetch(`${gw.url}/v1/channels/feishu`, { headers: auth(gw) });
    expect(res.status).toBe(500);
  });

  it('rejects non-GET methods', async () => {
    const gw = start(() => status());
    const res = await fetch(`${gw.url}/v1/channels/feishu`, {
      method: 'POST',
      headers: auth(gw),
    });
    expect(res.status).toBe(405);
  });
});
