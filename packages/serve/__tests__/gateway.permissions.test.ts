import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream, MemoryPluginHost } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import type { RunStatus } from '../src/protocol';
import { createGateway, createRuntime, TestWs, ToolCallingProvider, waitUntil } from './helpers';

/** 构造带 danger_tool 的 gateway；工具无 checkPermission，走 runtime 默认 'ask' */
async function makePermissionGateway(interactionsDir?: string) {
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
    runtime,
    pluginHost,
    ...(interactionsDir !== undefined ? { interactionsDir } : {}),
  });
  return { events, gw, state };
}

describe('gateway permissions', () => {
  const gateways: Gateway[] = [];
  const clients: TestWs[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const gw of gateways.splice(0)) gw.stop();
  });

  const connect = async (gw: Gateway) => {
    const client = await TestWs.connect(gw);
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');
    return client;
  };

  const submit = async (gw: Gateway, input: string) => {
    const res = await fetch(`${gw.url}/v1/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    expect(res.status).toBe(202);
    return (await res.json()) as { run_id: string };
  };

  it('delivers an approval to the tenant runtime stream (0.18)', async () => {
    // 生产装配：gateway 广播共享流，runtime 等的是 tenant 流；只有单向桥。
    const shared = new MemoryEventStream();
    const tenantEvents = new MemoryEventStream();
    const unsubBridge = tenantEvents.subscribe((event) => {
      shared.publish(event.tenant_id === undefined ? { ...event, tenant_id: 'default' } : event);
    });

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
      events: tenantEvents,
      pluginHost,
      provider: new ToolCallingProvider('danger_tool'),
      permission: { default: 'ask' },
    });
    const gw = createGateway({
      events: shared,
      runtime,
      pluginHost,
      tenantEventSources: () => [{ tenantId: 'default', events: tenantEvents }],
    });
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    const requestId = request.requestId as string;

    const res = await fetch(`${gw.url}/v1/permissions/${requestId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: false }),
    });
    expect(res.status).toBe(200);

    await client.nextEvent('run.completed');
    expect(state.executed).toBe(true);
    unsubBridge();
  });

  it('allows a tool after an explicit REST approval', async () => {
    const { gw, state } = await makePermissionGateway();
    gateways.push(gw);
    const client = await connect(gw);

    const { run_id } = await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    expect(request.tool).toBe('danger_tool');
    const requestId = request.requestId;
    expect(typeof requestId).toBe('string');

    const res = await fetch(`${gw.url}/v1/permissions/${requestId as string}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    await client.nextEvent('run.completed');
    expect(state.executed).toBe(true);
    await waitUntil(async () => {
      const statusRes = await fetch(`${gw.url}/v1/runs/${run_id}`, {
        headers: { Authorization: `Bearer ${gw.token}` },
      });
      return ((await statusRes.json()) as RunStatus).status === 'completed';
    });
  });

  it('denies a tool and lets the run finish with the error folded back', async () => {
    const { gw, state } = await makePermissionGateway();
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    const requestId = request.requestId as string;

    const res = await fetch(`${gw.url}/v1/permissions/${requestId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(res.status).toBe(200);

    await client.nextEvent('tool.call.failed');
    await client.nextEvent('run.completed');
    expect(state.executed).toBe(false);
  });

  it('supports permission.respond over WS and remembers always-allow', async () => {
    const { gw, state } = await makePermissionGateway();
    gateways.push(gw);
    const client = await connect(gw);

    // 第一次：通过 WS 应答 always allow
    await submit(gw, 'first');
    const firstRequest = await client.nextEvent('tool.permission.request');
    await client.request('permission.respond', {
      request_id: firstRequest.requestId,
      decision: 'allow',
      remember: true,
    });
    await client.nextEvent('run.completed');
    expect(state.executed).toBe(true);

    // 第二次：remember 生效，不再出现权限请求，直接执行
    state.executed = false;
    await submit(gw, 'second');
    await client.nextEvent('run.completed');
    expect(state.executed).toBe(true);
  });

  it('accepts scope and treats a duplicate response as idempotent', async () => {
    const { gw } = await makePermissionGateway();
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    const requestId = request.requestId as string;

    const first = (await client.request('permission.respond', {
      request_id: requestId,
      decision: 'allow',
      scope: 'session',
    })) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, decision: 'allow', scope: 'session' });

    await client.nextEvent('run.completed');

    // 幂等：同一 requestId 的重复应答返回上次结果，不再报 not_found。
    const repeat = (await client.request('permission.respond', {
      request_id: requestId,
      decision: 'allow',
    })) as Record<string, unknown>;
    expect(repeat).toMatchObject({
      ok: true,
      decision: 'allow',
      scope: 'session',
      duplicate: true,
    });
  });

  it('rejects an unknown permission scope', async () => {
    const { gw } = await makePermissionGateway();
    gateways.push(gw);
    const client = await connect(gw);

    await submit(gw, 'please run');
    const request = await client.nextEvent('tool.permission.request');
    let message = '';
    try {
      await client.request('permission.respond', {
        request_id: request.requestId,
        decision: 'allow',
        scope: 'forever',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // WS legacy 路径把 invalid_params 映射为 0.4 的 invalid_request。
    expect(message).toContain('invalid_request');
    expect(message).toContain('scope');
  });

  it('persists pending interactions when interactionsDir is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vessel-gateway-interactions-'));
    try {
      const { gw } = await makePermissionGateway(dir);
      gateways.push(gw);
      const client = await connect(gw);

      await submit(gw, 'please run');
      const request = await client.nextEvent('tool.permission.request');
      expect(typeof request.requestId).toBe('string');

      const path = join(dir, 'interactions-default.json');
      await waitUntil(
        () => existsSync(path) && readFileSync(path, 'utf8').includes('"status": "pending"'),
      );
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        interactions: Array<Record<string, unknown>>;
      };
      expect(file.interactions[0]).toMatchObject({
        requestId: request.requestId,
        tool: 'danger_tool',
        status: 'pending',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns not_found for an unknown permission request id', async () => {
    const { gw } = await makePermissionGateway();
    gateways.push(gw);
    const res = await fetch(`${gw.url}/v1/permissions/does-not-exist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid permission decisions', async () => {
    const { gw } = await makePermissionGateway();
    gateways.push(gw);
    const res = await fetch(`${gw.url}/v1/permissions/any`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });
});
