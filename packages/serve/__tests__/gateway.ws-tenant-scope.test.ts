/**
 * P0-1：legacy WS 方法必须经过 dispatcher，受 principal / tenant 作用域约束。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { ProtocolError, ServerFrame } from '../src/protocol';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway, createRuntime, TestWs, ToolCallingProvider, waitUntil } from './helpers';

const gateways: Gateway[] = [];
const clients: TestWs[] = [];

function authFor(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    admin: { tenant_id: '*', role: 'admin' },
    a: { tenant_id: 'a', role: 'write' },
    b: { tenant_id: 'b', role: 'write' },
    reader: { tenant_id: 'a', role: 'read' },
  };
  return {
    configured: true,
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

/** 非 default tenant 的 durable 查询走注入 store；这里返回空，确保跨 tenant 读取是 not_found。 */
const emptyDurableFor = (tenantId: string) =>
  tenantId === 'b' ? { store: { load: async () => null, list: async () => [] } } : undefined;

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const gw of gateways.splice(0)) gw.stop();
});

async function connect(gw: Gateway, token: string): Promise<TestWs> {
  const client = await TestWs.connect(gw, { token });
  clients.push(client);
  await client.next((frame) => frame.kind === 'hello');
  return client;
}

function requestFrame(client: TestWs, method: string, params?: unknown): Promise<ServerFrame> {
  const id = crypto.randomUUID();
  client.ws.send(JSON.stringify({ v: 1, kind: 'req', id, method, params }));
  return client.next((frame) => frame.kind === 'res' && frame.id === id);
}

function expectError(frame: ServerFrame, code: ProtocolError['code']): void {
  if (frame.kind !== 'res') throw new Error('expected res frame');
  expect(frame.ok).toBe(false);
  if (frame.ok) throw new Error('expected error frame');
  expect(frame.error.code).toBe(code);
}

function expectOk(frame: ServerFrame): unknown {
  if (frame.kind !== 'res') throw new Error('expected res frame');
  expect(frame.ok).toBe(true);
  if (!frame.ok)
    throw new Error(`expected success, got ${frame.error.code}: ${frame.error.message}`);
  return frame.result;
}

/** 直接订阅 core 事件流拿 requestId（WS 事件按 tenant 过滤，测试无需依赖它）。 */
function waitForRequestId(events: MemoryEventStream, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);
    unsubscribe = events.subscribe((event: RunEvent) => {
      if (event.type !== type) return;
      const data = event.data as Record<string, unknown>;
      if (typeof data.requestId !== 'string') return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(data.requestId);
    });
  });
}

describe('legacy WS methods are tenant-scoped', () => {
  it('submits into the caller tenant and hides the run from other tenants', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = createGateway({
      events,
      auth: authFor(),
      runtimeFor: () => runtime,
      durableFor: emptyDurableFor,
    });
    gateways.push(gw);
    const a = await connect(gw, 'a');
    const b = await connect(gw, 'b');

    const submitted = expectOk(
      await requestFrame(a, 'run.submit', { input: 'hello-a', session_id: 'session-a' }),
    ) as { run_id: string; status: string };
    expect(typeof submitted.run_id).toBe('string');
    expect(['queued', 'running']).toContain(submitted.status);

    // run 落在 A：canonical runs.list 按 tenant 过滤。
    const listA = expectOk(await requestFrame(a, 'runs.list')) as {
      runs: Array<{ run_id: string }>;
    };
    expect(listA.runs.map((run) => run.run_id)).toContain(submitted.run_id);
    const listB = expectOk(await requestFrame(b, 'runs.list')) as { runs: unknown[] };
    expect(listB.runs).toHaveLength(0);

    // legacy run.get 仍返回裸 RunStatus（不是 { run }）。
    const status = expectOk(
      await requestFrame(a, 'run.get', { run_id: submitted.run_id }),
    ) as Record<string, unknown>;
    expect(status.run_id).toBe(submitted.run_id);
    expect(status.run).toBeUndefined();

    // B 不能读取或取消 A 的 run。
    expectError(await requestFrame(b, 'run.get', { run_id: submitted.run_id }), 'not_found');
    expectError(await requestFrame(b, 'run.cancel', { run_id: submitted.run_id }), 'not_found');

    // A 的 run 未受影响。
    expect(
      (
        expectOk(await requestFrame(a, 'run.get', { run_id: submitted.run_id })) as {
          run_id: string;
        }
      ).run_id,
    ).toBe(submitted.run_id);
  });

  it('rejects a non-admin legacy tenant override', async () => {
    const events = new MemoryEventStream();
    const runtime = await createRuntime({ events });
    const gw = createGateway({ events, auth: authFor(), runtimeFor: () => runtime });
    gateways.push(gw);
    const a = await connect(gw, 'a');

    expectError(
      await requestFrame(a, 'run.submit', { input: 'cross', tenant_id: 'b' }),
      'forbidden',
    );
    // admin 可以显式落到其它 tenant。
    const admin = await connect(gw, 'admin');
    const submitted = expectOk(
      await requestFrame(admin, 'run.submit', { input: 'cross', tenant_id: 'b' }),
    ) as { run_id: string };
    const listB = expectOk(await requestFrame(admin, 'runs.list', { tenant_id: 'b' })) as {
      runs: Array<{ run_id: string }>;
    };
    expect(listB.runs.map((run) => run.run_id)).toContain(submitted.run_id);
  });

  it('cannot answer another tenant permission request', async () => {
    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    const state = { executed: false };
    pluginHost.registerTool({
      name: 'danger_tool',
      description: 'A tool that requires confirmation',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        state.executed = true;
        return 'executed';
      },
    });
    const runtime = await createRuntime({
      events,
      pluginHost,
      provider: new ToolCallingProvider('danger_tool'),
      permission: { default: 'ask' },
    });
    const gw = createGateway({
      events,
      auth: authFor(),
      runtimeFor: () => runtime,
      pluginHost,
      // 单 runtime 复用同一事件流；按 tenant 注册（gateway 会去重订阅）。
      tenantEventSources: () => [
        { tenantId: 'default', events },
        { tenantId: 'a', events },
        { tenantId: 'b', events },
      ],
    });
    gateways.push(gw);
    const a = await connect(gw, 'a');
    const b = await connect(gw, 'b');

    const pending = waitForRequestId(events, 'tool.permission.request');
    expectOk(await requestFrame(a, 'run.submit', { input: 'run tool' }));
    const requestId = await pending;

    expectError(
      await requestFrame(b, 'permission.respond', { request_id: requestId, decision: 'allow' }),
      'not_found',
    );
    expectOk(
      await requestFrame(a, 'permission.respond', { request_id: requestId, decision: 'allow' }),
    );
    await waitUntil(() => state.executed);
  });

  it('cannot answer another tenant ask request', async () => {
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
      events,
      pluginHost,
      provider: new ToolCallingProvider('ask_tool'),
      permission: { default: 'allow' },
    });
    const gw = createGateway({
      events,
      auth: authFor(),
      runtimeFor: () => runtime,
      pluginHost,
      tenantEventSources: () => [
        { tenantId: 'default', events },
        { tenantId: 'a', events },
        { tenantId: 'b', events },
      ],
    });
    gateways.push(gw);
    const a = await connect(gw, 'a');
    const b = await connect(gw, 'b');

    const pending = waitForRequestId(events, 'ask.user.requested');
    expectOk(await requestFrame(a, 'run.submit', { input: 'ask me' }));
    const requestId = await pending;

    expectError(
      await requestFrame(b, 'ask.respond', { request_id: requestId, answers: [] }),
      'not_found',
    );
    expectOk(
      await requestFrame(a, 'ask.respond', {
        request_id: requestId,
        answers: [{ header: 'Q', question: 'value?', answer: '42' }],
      }),
    );
    await waitUntil(() => state.answer === '42');
  });
});
