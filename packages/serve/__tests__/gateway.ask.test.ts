import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createGatewayEventHub } from '../src/tenant-event-hub';
import { createGateway, createRuntime, TestWs, ToolCallingProvider } from './helpers';

describe('gateway ask_user', () => {
  const gateways: Gateway[] = [];
  const clients: TestWs[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const gw of gateways.splice(0)) gw.stop();
  });

  it('answers ask.user.requested over REST', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    const state: { answer?: string } = {};
    pluginHost.registerTool({
      name: 'ask_tool',
      description: 'Ask the user',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = crypto.randomUUID();
        ctx.events.publish({
          type: 'ask.user.requested',
          run_id: ctx.run_id,
          data: {
            requestId,
            questions: [{ header: 'Q', question: 'value?' }],
          },
          ts: Date.now(),
        });
        const data = (await ctx.events.waitFor('ask.user.answered', {
          requestId,
          timeout: 5000,
        })) as { answers?: Array<{ answer?: string }> };
        state.answer = data.answers?.[0]?.answer;
        return `answer:${state.answer ?? 'none'}`;
      },
    });

    const runtime = await createRuntime({
      events,
      pluginHost,
      provider: new ToolCallingProvider('ask_tool'),
      permission: { default: 'allow' },
    });
    const gw = createGateway({ events, runtime, pluginHost });
    gateways.push(gw);

    const client = await TestWs.connect(gw);
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');

    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ask me' }),
    });
    expect(res.status).toBe(202);

    const request = await client.nextEvent('ask.user.requested');
    const requestId = request.requestId as string;
    expect(typeof requestId).toBe('string');

    const answerRes = await fetch(`${gw.url}/v1/ask/${requestId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [{ header: 'Q', question: 'value?', answer: '42' }],
      }),
    });
    expect(answerRes.status).toBe(200);
    expect(((await answerRes.json()) as { ok: boolean }).ok).toBe(true);

    await client.nextEvent('run.completed');
    expect(state.answer).toBe('42');
  });

  it('answers through the hub on the tenant runtime stream (0.18)', async () => {
    // runtime / 工具只认识自己的 tenant 流；gateway 通过 hub 扇入并投递应答。
    const tenantEvents = new MemoryEventStream();

    const pluginHost = new MemoryPluginHost();
    const state: { answer?: string } = {};
    pluginHost.registerTool({
      name: 'ask_tool',
      description: 'Ask the user',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const requestId = crypto.randomUUID();
        ctx.events.publish({
          type: 'ask.user.requested',
          run_id: ctx.run_id,
          data: { requestId, questions: [{ header: 'Q', question: 'value?' }] },
          ts: Date.now(),
        });
        const data = (await ctx.events.waitFor('ask.user.answered', {
          requestId,
          timeout: 5000,
        })) as { answers?: Array<{ answer?: string }> };
        state.answer = data.answers?.[0]?.answer;
        return `answer:${state.answer ?? 'none'}`;
      },
    });

    const runtime = await createRuntime({
      events: tenantEvents,
      pluginHost,
      provider: new ToolCallingProvider('ask_tool'),
      permission: { default: 'allow' },
    });
    const gw = createGateway({
      hub: createGatewayEventHub({
        streams: [{ tenantId: 'default', stream: tenantEvents }],
      }),
      runtime,
      pluginHost,
    });
    gateways.push(gw);

    const client = await TestWs.connect(gw);
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');

    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ask me' }),
    });
    expect(res.status).toBe(202);

    const request = await client.nextEvent('ask.user.requested');
    const requestId = request.requestId as string;

    const answerRes = await fetch(`${gw.url}/v1/ask/${requestId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [{ header: 'Q', question: 'value?', answer: '42' }],
      }),
    });
    expect(answerRes.status).toBe(200);

    await client.nextEvent('run.completed');
    expect(state.answer).toBe('42');
  });

  it('supports ask.respond over WS and rejects unknown ids', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = createGateway({ events, runtime });
    gateways.push(gw);
    const client = await TestWs.connect(gw);
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');

    const id = 'missing-ask';
    client.ws.send(
      JSON.stringify({
        v: 1,
        kind: 'req',
        id,
        method: 'ask.respond',
        params: { request_id: 'nope', answers: [] },
      }),
    );
    const res = await client.next((frame) => frame.kind === 'res' && frame.id === id);
    if (res.kind !== 'res' || res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('not_found');
  });
});
